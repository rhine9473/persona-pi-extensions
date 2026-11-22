import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  activateAccount,
  clearAccountCooldown,
  getFailoverEvents,
  listAccounts,
  moveAccountOrder,
  onAccountsChanged,
  poolDisplayName,
  poolKeyForModel,
  promoteAccountToPrimary,
  removeAccount,
  toggleAccountRotation,
  type AccountSummary,
} from "../auth/accounts.js";
import { getLastDiagnostics, onDiagnosticsUpdated } from "../diagnostics/diagnostics.js";
import { getCurrentAntigravityCatalog, PROVIDER_ID } from "../models/models.js";
import {
  type AntigravityModelConfig,
  type AntigravitySettings,
  type QuotaPoolKey,
  type ThinkingEffort,
} from "../types/types.js";
import { refreshAllAccountsUsage } from "../usage/usage.js";
import { getCreditsStatus, setCreditsEnabled } from "../utils/credits.js";
import { loadAntigravitySettings, saveAntigravitySettings } from "../utils/settings.js";
import {
  accountStatusText,
  cleanModelName,
  formatClockTime,
  formatContextShort,
  formatCountdown,
  formatRelativeAge,
  formatResetIso,
  maskEmailAddress,
  padLeft,
  padRight,
  quotaColor,
  renderPoolCell,
  renderQuotaBar,
  resolveGlyphs,
  shortEmail,
  tierBadge,
  type Glyphs,
} from "./format.js";
import { startInlineLogin, type InlineLoginState } from "./login-view.js";
import { copyToClipboard, openUrlInBrowser } from "./platform.js";

export type ConsoleTab = "accounts" | "models" | "diagnostics";

const STALE_STATIC_FALLBACK_IDS = new Set([
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-3.1-pro",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gpt-oss-120b",
]);

const ALL_THINKING_LEVELS: Array<{ level: "low" | "medium" | "high" | "xhigh"; label: string }> = [
  { level: "low", label: "low" },
  { level: "medium", label: "med" },
  { level: "high", label: "high" },
  { level: "xhigh", label: "xhigh" },
];

type DiagRow = {
  id: string;
  section: "health" | "setting" | "event";
  label: string;
  value: string;
  note?: string;
  status?: "ok" | "warn" | "err" | "dim";
  actionHint?: string;
  locked?: boolean;
};

export type ConsoleOpenOptions = {
  initialTab?: ConsoleTab;
  refreshOnOpen?: boolean;
  focusCredits?: boolean;
};

export async function openAntigravityConsole(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: ConsoleOpenOptions = {},
): Promise<void> {
  if (!ctx.hasUI) return;
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => new AntigravityConsole(pi, ctx, tui, theme, kb, done, options),
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    },
  );
}

export class AntigravityConsole implements Component, Focusable {
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionCommandContext;
  private readonly tui: { requestRender: () => void; terminal?: { rows?: number; columns?: number } };
  private readonly theme: Theme;
  private readonly kb: KeybindingsManager;
  private readonly done: () => void;

  private settings: AntigravitySettings;
  private tab: ConsoleTab;
  private accounts: AccountSummary[] = [];
  private selectedAccountIdx = 0;
  private selectedModelIdx = 0;
  private selectedDiagIdx = 0;
  private modelThinkingSelection = new Map<string, string>();
  private showRuntimeIds = false;
  private compactDetailOpen = false;

  private searching = false;
  private searchInput = new Input({ prompt: " 筛选: ", placeholder: "邮箱 / 模型名 / ID" });
  private filterQuery = "";

  private confirmDeleteId: string | undefined;
  private loginState: InlineLoginState | undefined;

  private refreshingIds = new Set<string>();
  private spinnerIdx = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private countdownTimer: ReturnType<typeof setInterval> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private flashMessage: { text: string; tone: "info" | "success" | "warning" | "error" } | undefined;

  private unsubAccounts: (() => void) | undefined;
  private unsubDiag: (() => void) | undefined;
  private disposed = false;
  private _focused = false;

  constructor(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    tui: { requestRender: () => void; terminal?: { rows?: number; columns?: number } },
    theme: Theme,
    kb: KeybindingsManager,
    done: () => void,
    options: ConsoleOpenOptions = {},
  ) {
    this.pi = pi;
    this.ctx = ctx;
    this.tui = tui;
    this.theme = theme;
    this.kb = kb;
    this.done = done;
    this.settings = loadAntigravitySettings();
    this.tab = options.initialTab ?? this.settings.lastTab ?? "accounts";
    this.reloadData();

    if (options.focusCredits && this.tab === "diagnostics") {
      const rows = this.buildDiagnosticsRows();
      const idx = rows.findIndex((r) => r.id === "set-credits");
      if (idx >= 0) this.selectedDiagIdx = idx;
    }

    this.unsubAccounts = onAccountsChanged(() => {
      if (this.disposed) return;
      this.reloadData();
      this.tui.requestRender();
    });
    this.unsubDiag = onDiagnosticsUpdated(() => {
      if (this.disposed) return;
      this.tui.requestRender();
    });

    this.searchInput.onEscape = () => {
      this.searching = false;
      this.searchInput.focused = false;
      this.tui.requestRender();
    };
    this.searchInput.onSubmit = () => {
      this.filterQuery = this.searchInput.getValue().trim();
      this.searching = false;
      this.searchInput.focused = false;
      this.tui.requestRender();
    };

    this.scheduleCountdownTimer();

    if (options.refreshOnOpen || this.needsInitialRefresh()) {
      this.triggerRefreshAll();
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(val: boolean) {
    this._focused = val;
    this.searchInput.focused = val && this.searching;
    if (this.loginState) this.loginState.input.focused = val;
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.loginState?.input.invalidate();
  }

  private close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loginState?.cancel();
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.unsubAccounts?.();
    this.unsubDiag?.();
    this.done();
  }

  private setFlash(text: string, tone: "info" | "success" | "warning" | "error" = "info"): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashMessage = { text, tone };
    this.flashTimer = setTimeout(() => {
      this.flashMessage = undefined;
      if (!this.disposed) this.tui.requestRender();
    }, 3000);
    this.tui.requestRender();
  }

  private needsInitialRefresh(): boolean {
    if (!this.accounts.length) return false;
    const now = Date.now();
    return this.accounts.some(
      (a) => !a.cachedUsage || now - a.cachedUsage.fetchedAt > 5 * 60_000,
    );
  }

  private reloadData(): void {
    this.accounts = listAccounts();
    if (this.selectedAccountIdx >= this.accounts.length) {
      this.selectedAccountIdx = Math.max(0, this.accounts.length - 1);
    }
    const models = this.filteredModels();
    if (this.selectedModelIdx >= models.length) {
      this.selectedModelIdx = Math.max(0, models.length - 1);
    }
  }

  private scheduleCountdownTimer(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    const now = Date.now();
    const hasUnderHour = this.accounts.some((acc) =>
      Object.values(acc.poolCooldowns).some((cd) => cd && cd.until > now && cd.until - now < 3_600_000),
    );
    const interval = hasUnderHour ? 1000 : 30_000;
    this.countdownTimer = setInterval(() => {
      if (this.disposed) return;
      this.tui.requestRender();
    }, interval);
  }

  private triggerRefreshAll(): void {
    if (!this.accounts.length || this.refreshingIds.size > 0) return;
    for (const acc of this.accounts) this.refreshingIds.add(acc.accountId);
    if (!this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        if (this.disposed) return;
        this.spinnerIdx = (this.spinnerIdx + 1) % 10;
        this.tui.requestRender();
      }, 120);
    }
    this.tui.requestRender();

    void refreshAllAccountsUsage((accountId) => {
      if (this.disposed) return;
      this.refreshingIds.delete(accountId);
      this.reloadData();
      if (this.refreshingIds.size === 0 && this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = undefined;
        this.scheduleCountdownTimer();
        this.setFlash("额度已同步", "success");
      }
      this.tui.requestRender();
    });
  }

  private filteredAccounts(): AccountSummary[] {
    const q = this.filterQuery.toLowerCase();
    if (!q) return this.accounts;
    return this.accounts.filter((a) =>
      `${a.email ?? ""} ${a.accountId} ${a.planLabel ?? ""}`.toLowerCase().includes(q),
    );
  }

  private filteredModels(): AntigravityModelConfig[] {
    const q = this.filterQuery.toLowerCase();
    const catalog = getCurrentAntigravityCatalog().models;
    if (!q) return catalog;
    return catalog.filter((m) =>
      `${m.id} ${cleanModelName(m.name)}`.toLowerCase().includes(q),
    );
  }

  private switchTab(tab: ConsoleTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.confirmDeleteId = undefined;
    this.compactDetailOpen = false;
    this.settings = saveAntigravitySettings({ lastTab: tab });
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const g = resolveGlyphs(this.settings.glyphs);
    const termRows = Math.max(10, this.tui.terminal?.rows ?? 28);
    const maxCardWidth = Math.min(132, Math.max(40, width));
    const innerWidth = Math.max(36, maxCardWidth - 2);
    const leftPad = width > maxCardWidth ? " ".repeat(Math.floor((width - maxCardWidth) / 2)) : "";
    const now = Date.now();
    const spinnerFrame = g.spinner[this.spinnerIdx % g.spinner.length] ?? "*";

    const lines: string[] = [];

    // 1. Tab bar
    lines.push(this.renderTabsLine(g, innerWidth, now));
    lines.push(this.renderTabUnderline(g, innerWidth));

    // Optional live search bar
    if (this.searching || this.filterQuery) {
      if (this.searching) {
        lines.push(...this.searchInput.render(innerWidth).map((l) => ` ${l}`));
      } else {
        lines.push(
          ` ${this.theme.fg("muted", "筛选:")} ${this.theme.fg("accent", this.filterQuery)} ${this.theme.fg("dim", "(Esc 清空)")}`,
        );
      }
    }

    const contentBudget = Math.max(4, termRows - 6); // top border, tab, underline, bottom hint, bottom border
    let bodyLines: string[] = [];

    if (this.loginState?.active) {
      bodyLines = this.loginState.render(this.theme, g, spinnerFrame, innerWidth);
    } else if (this.tab === "accounts") {
      bodyLines = this.renderAccountsBody(g, innerWidth, contentBudget, spinnerFrame, now);
    } else if (this.tab === "models") {
      bodyLines = this.renderModelsBody(g, innerWidth, contentBudget, now);
    } else {
      bodyLines = this.renderDiagnosticsBody(g, innerWidth, contentBudget, now);
    }

    // Pad or trim body to fixed height to eliminate jitter
    while (bodyLines.length < contentBudget) bodyLines.push("");
    if (bodyLines.length > contentBudget) bodyLines = bodyLines.slice(0, contentBudget);

    // Bottom hint / flash line inside frame
    const footerLine = this.renderBottomHintLine(g, innerWidth);
    lines.push(this.theme.fg("borderMuted", g.rule.repeat(innerWidth)));
    lines.push(footerLine);

    const allInner = [...lines.slice(0, 2), ...(this.searching || this.filterQuery ? [lines[2]!] : []), ...bodyLines, ...lines.slice(-2)];
    while (allInner.length < Math.max(8, termRows - 2)) {
      allInner.splice(allInner.length - 2, 0, "");
    }
    if (allInner.length > Math.max(8, termRows - 2)) {
      allInner.length = Math.max(8, termRows - 2);
    }

    const headerTitle = "Antigravity";
    const rightMeta = this.buildTopRightMeta(g, now);
    const framed = renderBox(this.theme, g, headerTitle, rightMeta, allInner, innerWidth);
    return framed.map((l) => truncateToWidth(`${leftPad}${l}`, width, ""));
  }

  private buildTopRightMeta(g: Glyphs, now: number): string {
    if (this.tab === "models") {
      const m = this.ctx.model;
      if (m?.provider === PROVIDER_ID) {
        const level = this.pi.getThinkingLevel();
        return `当前 ${cleanModelName(m.name)} · ${level}`;
      }
      return `${getCurrentAntigravityCatalog().models.length} 个模型`;
    }
    const strategyName =
      this.settings.strategy === "sticky"
        ? "粘性优先"
        : this.settings.strategy === "round-robin"
          ? "轮询"
          : "最高余量";
    const enabled = this.accounts.filter((a) => a.enabled);
    const readyCount = enabled.filter((a) => a.authStatus === "ready").length;
    const active = this.accounts.find((a) => a.active);
    const latestSync = this.accounts.reduce(
      (max, a) => Math.max(max, a.cachedUsage?.fetchedAt ?? 0),
      0,
    );
    const activeLabel = active ? shortEmail(active.email, this.settings.maskEmails) : "无";
    const syncLabel = this.refreshingIds.size > 0 ? "同步中…" : `同步 ${formatRelativeAge(latestSync, now)}`;
    return `${strategyName} · 可用 ${readyCount}/${this.accounts.length} · ${g.dot} ${activeLabel} · ${syncLabel}`;
  }

  private renderTabsLine(g: Glyphs, innerWidth: number, now: number): string {
    const modelsCount = getCurrentAntigravityCatalog().models.length;
    const diagIssues = this.countDiagIssues(now);
    const t1 = `1 账号 ${this.accounts.length}`;
    const t2 = `2 模型 ${modelsCount}`;
    const t3 = diagIssues > 0 ? `3 诊断 ${g.warn}${diagIssues}` : "3 诊断";

    const fmtTab = (id: ConsoleTab, label: string) =>
      this.tab === id ? this.theme.bold(this.theme.fg("accent", label)) : this.theme.fg("muted", label);

    const row = ` ${fmtTab("accounts", t1)}    ${fmtTab("models", t2)}    ${fmtTab("diagnostics", t3)}`;
    return padRight(row, innerWidth);
  }

  private renderTabUnderline(g: Glyphs, innerWidth: number): string {
    const modelsCount = getCurrentAntigravityCatalog().models.length;
    const w1 = visibleWidth(`1 账号 ${this.accounts.length}`);
    const w2 = visibleWidth(`2 模型 ${modelsCount}`);
    const w3 = visibleWidth("3 诊断") + (this.countDiagIssues(Date.now()) > 0 ? 3 : 0);

    const start1 = 1;
    const start2 = start1 + w1 + 4;
    const start3 = start2 + w2 + 4;
    const activeStart = this.tab === "accounts" ? start1 : this.tab === "models" ? start2 : start3;
    const activeLen = this.tab === "accounts" ? w1 : this.tab === "models" ? w2 : w3;

    const pre = this.theme.fg("borderMuted", g.rule.repeat(activeStart));
    const mid = this.theme.fg("accent", g.activeRule.repeat(Math.min(activeLen, Math.max(1, innerWidth - activeStart))));
    const postLen = Math.max(0, innerWidth - activeStart - activeLen);
    const post = this.theme.fg("borderMuted", g.rule.repeat(postLen));
    return `${pre}${mid}${post}`;
  }

  private countDiagIssues(now: number): number {
    let issues = 0;
    for (const acc of this.accounts) {
      if (acc.authStatus !== "ready") issues++;
      else if (
        acc.poolCooldowns.gemini &&
        acc.poolCooldowns.gemini.until > now &&
        acc.poolCooldowns.claude_gpt &&
        acc.poolCooldowns.claude_gpt.until > now
      ) {
        issues++;
      }
    }
    return issues;
  }

  private renderAccountsBody(
    g: Glyphs,
    innerWidth: number,
    budget: number,
    spinnerFrame: string,
    now: number,
  ): string[] {
    const accounts = this.filteredAccounts();
    if (!accounts.length) {
      return [
        "",
        `  ${this.theme.fg("muted", this.filterQuery ? "没有匹配的账号" : "尚未绑定任何 Google 账号")}`,
        "",
        `  ${this.theme.fg("dim", "按")} ${this.theme.fg("accent", "a")} ${this.theme.fg("dim", "添加并登录第一个 Antigravity 账号")}`,
      ];
    }

    const lines: string[] = [];
    const selectedAcc = accounts[this.selectedAccountIdx];
    const showDetail = budget >= 14 && Boolean(selectedAcc) && (innerWidth >= 90 || this.compactDetailOpen);
    const detailLines =
      showDetail && selectedAcc ? this.renderAccountDetail(g, selectedAcc, innerWidth, now) : [];
    const listBudget = Math.max(3, budget - (detailLines.length ? detailLines.length + 1 : 0));

    if (innerWidth >= 90) {
      // Table mode (>=120 wide: full 24-char 5h/7d cells + conditional credits; 90-119: 20-char 5h/7d cells)
      const wide = innerWidth >= 120;
      const hasAnyCredits = accounts.some((a) => a.cachedUsage?.credits !== undefined);
      const showCredits = wide && hasAnyCredits;
      const barW = wide ? 10 : 6;
      const poolW = wide ? 26 : 20;
      const creditsW = showCredits ? 8 : 0;
      const orderW = 5;
      const tierW = 6;
      const statusW = 10;
      const rotW = 4;
      const fixedW =
        2 + orderW + 2 + 2 + tierW + 2 + statusW + 2 + rotW + 2 + poolW + 2 + poolW + (showCredits ? 2 + creditsW : 0) + 1;
      const emailW = Math.max(16, innerWidth - fixedW);

      const header =
        `  ${padRight("顺序", orderW)}  ${padRight("账号", emailW)}  ${padRight("套餐", tierW)}  ${padRight("状态", statusW)}  ${padRight("轮转", rotW)}  ${padRight("Gemini", poolW)}  ${padRight("Claude / GPT", poolW)}` +
        (showCredits ? `  ${padLeft("积分", creditsW)}` : "");
      lines.push(this.theme.fg("muted", header));

      const rowsPerItem = 1;
      const maxItems = Math.max(1, Math.floor((listBudget - 1) / rowsPerItem));
      const start = Math.max(0, Math.min(this.selectedAccountIdx - Math.floor(maxItems / 2), accounts.length - maxItems));
      const visible = accounts.slice(start, start + maxItems);

      for (let i = 0; i < visible.length; i++) {
        const acc = visible[i]!;
        const globalIdx = start + i;
        const selected = globalIdx === this.selectedAccountIdx;
        const deleting = this.confirmDeleteId === acc.accountId;
        const isPrimary = acc.order === 0;
        const loading = this.refreshingIds.has(acc.accountId) ? spinnerFrame : undefined;

        const orderTxt = !acc.enabled
          ? this.theme.fg("dim", padRight(" –", orderW))
          : isPrimary
            ? this.theme.fg("accent", padRight(`${g.primary}1`, orderW))
            : this.theme.fg("muted", padRight(` ${globalIdx + 1}`, orderW));

        const emailTxt = padRight(maskEmailAddress(acc.email, this.settings.maskEmails), emailW);
        const emailStyled = !acc.enabled
          ? this.theme.fg("dim", emailTxt)
          : selected
            ? this.theme.bold(this.theme.fg("text", emailTxt))
            : this.theme.fg("text", emailTxt);

        const badge = tierBadge(acc.planLabel);
        const badgePadded = padRight(badge.label, tierW);
        const badgeStyled = !acc.enabled
          ? this.theme.fg("dim", badgePadded)
          : badge.kind === "ultra"
            ? this.theme.bold(this.theme.fg("accent", badgePadded))
            : badge.kind === "pro"
              ? this.theme.bold(this.theme.fg("text", badgePadded))
              : this.theme.fg("muted", badgePadded);

        const st = accountStatusText(acc, now);
        const stStr = padRight(`${g[st.glyphKey]} ${st.text}`, statusW);
        const stStyled = this.theme.fg(st.color, stStr);

        const rotStyled = acc.enabled
          ? this.theme.fg("success", padRight(` ${g.check}`, rotW))
          : this.theme.fg("dim", padRight(` ${g.offDot}`, rotW));

        const gCell = renderPoolCell(this.theme, g, acc, "gemini", barW, poolW, loading, now);
        const cCell = renderPoolCell(this.theme, g, acc, "claude_gpt", barW, poolW, loading, now);
        const crVal =
          acc.cachedUsage?.credits !== undefined ? acc.cachedUsage.credits.toLocaleString() : "—";
        const crCell = showCredits
          ? `  ${this.theme.fg(acc.cachedUsage?.credits ? "text" : "dim", padLeft(crVal, creditsW))}`
          : "";

        const lead = selected ? this.theme.fg("accent", `${g.cursor} `) : "  ";
        const rawRow = `${lead}${orderTxt}  ${emailStyled}  ${badgeStyled}  ${stStyled}  ${rotStyled}  ${gCell}  ${cCell}${crCell}`;
        const padded = padRight(rawRow, innerWidth);
        lines.push(
          deleting
            ? this.theme.bg("toolErrorBg", padded)
            : selected
              ? this.theme.bg("selectedBg", padded)
              : padded,
        );
      }
    } else if (innerWidth >= 60) {
      // Compact 2-line card mode (60-89)
      const compactPoolW = Math.min(24, Math.max(18, Math.floor((innerWidth - 11) / 2)));
      const maxItems = Math.max(1, Math.floor(listBudget / 2));
      const start = Math.max(0, Math.min(this.selectedAccountIdx - Math.floor(maxItems / 2), accounts.length - maxItems));
      const visible = accounts.slice(start, start + maxItems);
      for (let i = 0; i < visible.length; i++) {
        const acc = visible[i]!;
        const globalIdx = start + i;
        const selected = globalIdx === this.selectedAccountIdx;
        const deleting = this.confirmDeleteId === acc.accountId;
        const loading = this.refreshingIds.has(acc.accountId) ? spinnerFrame : undefined;
        const badge = tierBadge(acc.planLabel);
        const st = accountStatusText(acc, now);
        const prefix = selected ? this.theme.fg("accent", `${g.cursor}`) : " ";
        const ord = acc.order === 0 ? this.theme.fg("accent", `${g.primary}1`) : this.theme.fg("muted", ` ${globalIdx + 1}`);
        const email = padRight(maskEmailAddress(acc.email, this.settings.maskEmails), Math.max(16, innerWidth - 26));
        const r1 = padRight(
          `${prefix}${ord} ${this.theme.fg(acc.enabled ? "text" : "dim", email)}  ${this.theme.fg(badge.kind === "ultra" ? "accent" : "muted", padRight(badge.label, 5))}  ${this.theme.fg(st.color, padRight(`${g[st.glyphKey]} ${st.text}`, 9))}`,
          innerWidth,
        );
        const gCell = renderPoolCell(this.theme, g, acc, "gemini", 6, compactPoolW, loading, now);
        const cCell = renderPoolCell(this.theme, g, acc, "claude_gpt", 6, compactPoolW, loading, now);
        const r2 = padRight(`     ${this.theme.fg("muted", "G")} ${gCell}  ${this.theme.fg("muted", "C")} ${cCell}`, innerWidth);
        lines.push(deleting ? this.theme.bg("toolErrorBg", r1) : selected ? this.theme.bg("selectedBg", r1) : r1);
        lines.push(deleting ? this.theme.bg("toolErrorBg", r2) : selected ? this.theme.bg("selectedBg", r2) : r2);
      }
    } else {
      // Minimal 1-line mode (<60)
      const miniPoolW = 13;
      const maxItems = Math.max(1, listBudget);
      const start = Math.max(0, Math.min(this.selectedAccountIdx - Math.floor(maxItems / 2), accounts.length - maxItems));
      const visible = accounts.slice(start, start + maxItems);
      for (let i = 0; i < visible.length; i++) {
        const acc = visible[i]!;
        const globalIdx = start + i;
        const selected = globalIdx === this.selectedAccountIdx;
        const st = accountStatusText(acc, now);
        const name = padRight(shortEmail(acc.email, this.settings.maskEmails), Math.max(8, innerWidth - 33));
        const gC = renderPoolCell(this.theme, g, acc, "gemini", 0, miniPoolW, undefined, now);
        const cC = renderPoolCell(this.theme, g, acc, "claude_gpt", 0, miniPoolW, undefined, now);
        const row = padRight(
          `${selected ? this.theme.fg("accent", g.cursor) : " "}${this.theme.fg(st.color, g[st.glyphKey])} ${this.theme.fg(acc.enabled ? "text" : "dim", name)} ${this.theme.fg("dim", "G")}${gC} ${this.theme.fg("dim", "C")}${cC}`,
          innerWidth,
        );
        lines.push(selected ? this.theme.bg("selectedBg", row) : row);
      }
    }

    if (detailLines.length) {
      lines.push(this.theme.fg("borderMuted", g.rule.repeat(innerWidth)));
      lines.push(...detailLines);
    }

    return lines;
  }

  private renderAccountDetail(
    g: Glyphs,
    acc: AccountSummary,
    innerWidth: number,
    now: number,
  ): string[] {
    const out: string[] = [];
    const badge = tierBadge(acc.planLabel);
    const fullEmail = acc.email ?? acc.accountId;
    const primaryNote = acc.order === 0 ? ` · ${this.theme.fg("accent", "首选")}` : "";
    const lastEvt = getFailoverEvents().find(
      (e) => e.fromAccountId === acc.accountId || e.toAccountId === acc.accountId,
    );
    const evtText = lastEvt
      ? `${formatClockTime(lastEvt.at)} ${g.swap} ${lastEvt.reason} (${shortEmail(lastEvt.toEmail ?? lastEvt.toAccountId, this.settings.maskEmails)})`
      : "";
    const leftTitle = ` ${this.theme.bold(this.theme.fg("text", fullEmail))}  ${this.theme.fg(badge.kind === "ultra" ? "accent" : "muted", badge.label)}${acc.planLabel ? this.theme.fg("dim", ` · ${acc.planLabel}`) : ""}${primaryNote}`;
    const rightSpace = Math.max(0, innerWidth - visibleWidth(leftTitle) - visibleWidth(evtText) - 1);
    out.push(`${leftTitle}${" ".repeat(rightSpace)}${this.theme.fg("dim", evtText)}`);

    if (acc.authStatus !== "ready" && acc.authError) {
      out.push(` ${this.theme.fg("error", `${g.err} ${truncateToWidth(acc.authError, Math.max(20, innerWidth - 6), "…")}`)}`);
      if (acc.verifyUrl) {
        out.push(` ${this.theme.fg("warning", "验证链接:")} ${this.theme.fg("accent", truncateToWidth(acc.verifyUrl, Math.max(20, innerWidth - 14), "…"))} ${this.theme.fg("dim", "(按 o 打开)")}`);
      }
    } else if (acc.cachedUsage?.error) {
      out.push(` ${this.theme.fg("warning", `${g.warn} 拉取失败: ${truncateToWidth(acc.cachedUsage.error, Math.max(20, innerWidth - 14), "…")}`)}`);
    }

    const barW = innerWidth >= 95 ? 28 : 16;
    const renderPoolDetailLine = (
      poolLabel: string,
      pool: QuotaPoolKey,
      windowLabel: string,
      isPrimaryWindow: boolean,
      frac?: number,
      resetIso?: string,
    ) => {
      const cd = acc.poolCooldowns[pool];
      if (cd && cd.until > now && isPrimaryWindow) {
        const untilClock = formatClockTime(cd.until);
        const cachedPct = frac !== undefined ? ` · 缓存 ${Math.round(frac * 100)}%` : "";
        return ` ${this.theme.fg("muted", padRight(poolLabel, 16))} ${this.theme.fg("dim", padRight(windowLabel, 8))} ${this.theme.fg("warning", `${g.cooling} 冷却中 · ${untilClock} 恢复 (${formatCountdown(cd.until, now, cd.estimated)})${cachedPct}`)}`;
      }
      const bar = renderQuotaBar(this.theme, g, frac, barW, false);
      const pct = frac !== undefined ? `${String(Math.round(frac * 100)).padStart(3)}%` : "  — ";
      const rst = resetIso ? formatResetIso(resetIso, now) : "";
      return ` ${this.theme.fg("muted", padRight(poolLabel, 16))} ${this.theme.fg("dim", padRight(windowLabel, 8))} ${bar}  ${this.theme.fg(frac !== undefined && frac < 0.2 ? "error" : "text", pct)}  ${this.theme.fg("dim", rst)}`;
    };

    const gp = acc.cachedUsage?.pools.gemini;
    const cp = acc.cachedUsage?.pools.claude_gpt;
    const ap = acc.cachedUsage?.pools.argon;
    out.push(renderPoolDetailLine("Gemini", "gemini", "5h 额度", true, gp?.remaining5h ?? gp?.remaining, gp?.reset5h ?? gp?.resetTime));
    out.push(renderPoolDetailLine("", "gemini", "7d 额度", false, gp?.remainingWeekly, gp?.resetWeekly));
    out.push(renderPoolDetailLine("Claude / GPT", "claude_gpt", "5h 额度", true, cp?.remaining5h ?? cp?.remaining, cp?.reset5h ?? cp?.resetTime));
    out.push(renderPoolDetailLine("", "claude_gpt", "7d 额度", false, cp?.remainingWeekly, cp?.resetWeekly));
    if (ap) {
      if (ap.remaining5h !== undefined) {
        out.push(renderPoolDetailLine("Gemini 4 Argon", "argon", "5h 额度", true, ap.remaining5h, ap.reset5h ?? ap.resetTime));
        out.push(renderPoolDetailLine("", "argon", "7d 额度", false, ap.remainingWeekly ?? ap.remaining, ap.resetWeekly ?? ap.resetTime));
      } else {
        out.push(renderPoolDetailLine("Gemini 4 Argon", "argon", "7d 额度", true, ap.remainingWeekly ?? ap.remaining, ap.resetWeekly ?? ap.resetTime));
      }
    }

    const creditsStatus = getCreditsStatus();
    if (acc.cachedUsage?.credits !== undefined || creditsStatus.enabled) {
      const crText =
        acc.cachedUsage?.credits !== undefined ? acc.cachedUsage.credits.toLocaleString() : "—";
      out.push(
        ` ${this.theme.fg("muted", "AI 积分")} ${this.theme.fg("text", crText)}  ${this.theme.fg("dim", "·")}  ${this.theme.fg("muted", "超额兜底")} ${this.theme.fg(creditsStatus.enabled ? "success" : "dim", creditsStatus.enabled ? "开" : "关")}`,
      );
    }

    return out;
  }

  private renderModelsBody(
    g: Glyphs,
    innerWidth: number,
    budget: number,
    now: number,
  ): string[] {
    const models = this.filteredModels();
    const catalog = getCurrentAntigravityCatalog();
    if (!models.length) {
      return ["", `  ${this.theme.fg("muted", "没有匹配的模型")}`];
    }

    const lines: string[] = [];
    const activeModelId = this.ctx.model?.provider === PROVIDER_ID ? this.ctx.model.id : undefined;
    const activeThinking = this.pi.getThinkingLevel();
    const activeAccount = this.accounts.find((a) => a.active) ?? this.accounts[0];

    // Group models by quota pool for clean visual headers
    const poolsOrder: QuotaPoolKey[] = ["gemini", "argon", "claude_gpt"];
    const grouped: Array<{ pool?: QuotaPoolKey; model: AntigravityModelConfig; idx: number }> = [];
    const byPool = new Map<QuotaPoolKey, Array<{ model: AntigravityModelConfig; idx: number }>>();
    for (const p of poolsOrder) byPool.set(p, []);

    const orderedModels: AntigravityModelConfig[] = [];
    for (const pool of poolsOrder) {
      for (const m of models) {
        if (poolKeyForModel(m.id) === pool) orderedModels.push(m);
      }
    }

    orderedModels.forEach((m, idx) => {
      const pool = poolKeyForModel(m.id);
      byPool.get(pool)!.push({ model: m, idx });
    });

    for (const pool of poolsOrder) {
      const list = byPool.get(pool)!;
      if (!list.length) continue;
      grouped.push({ pool, model: list[0]!.model, idx: -1 });
      for (const item of list) grouped.push({ model: item.model, idx: item.idx });
    }

    const showDetail = budget >= 14;
    const detailH = showDetail ? 4 : 0;
    const listBudget = Math.max(4, budget - detailH - (showDetail ? 1 : 0));

    // Find visual index of selected model inside `grouped`
    const selectedVisualIdx = grouped.findIndex((row) => row.idx === this.selectedModelIdx);
    const start = Math.max(
      0,
      Math.min(Math.max(0, selectedVisualIdx) - Math.floor(listBudget / 2), grouped.length - listBudget),
    );
    const visible = grouped.slice(start, start + listBudget);

    for (const row of visible) {
      if (row.idx === -1 && row.pool) {
        const pool = row.pool;
        const readyAccs = this.accounts.filter((a) => {
          if (!a.enabled || a.authStatus !== "ready") return false;
          const cd = a.poolCooldowns[pool];
          return !(cd && cd.until > now);
        }).length;
        const quota = activeAccount?.cachedUsage?.pools[pool];
        const cd = activeAccount?.poolCooldowns[pool];
        const q5 = quota?.remaining5h;
        const q7 = quota?.remainingWeekly;
        const qAny = quota?.remaining;
        let poolStatus: string;
        if (cd && cd.until > now) {
          poolStatus = this.theme.fg("warning", `${g.cooling} 当前号冷却 (${formatCountdown(cd.until, now, cd.estimated)})`);
        } else if (q5 !== undefined && q7 !== undefined) {
          const p5 =
            q5 <= 0
              ? this.theme.fg("error", "耗尽")
              : this.theme.fg(quotaColor(this.theme, q5), `${Math.round(q5 * 100)}%`);
          const p7 =
            q7 <= 0
              ? this.theme.fg("error", "耗尽")
              : this.theme.fg(quotaColor(this.theme, q7), `${Math.round(q7 * 100)}%`);
          poolStatus = `${this.theme.fg("muted", "5h")} ${renderQuotaBar(this.theme, g, q5, 6)} ${p5} ${this.theme.fg("dim", "·")} ${this.theme.fg("muted", "7d")} ${p7}`;
        } else if (q5 !== undefined || q7 !== undefined || qAny !== undefined) {
          const frac = q5 ?? q7 ?? qAny!;
          const tag = q5 !== undefined ? "5h " : q7 !== undefined ? "7d " : "";
          const pct =
            frac <= 0
              ? this.theme.fg("error", "耗尽")
              : this.theme.fg(quotaColor(this.theme, frac), `${Math.round(frac * 100)}%`);
          poolStatus = `${this.theme.fg("muted", tag)}${renderQuotaBar(this.theme, g, frac, 10)}  ${pct}`;
        } else {
          poolStatus = this.theme.fg("dim", "—");
        }
        lines.push(
          padRight(
            ` ${this.theme.bold(this.theme.fg("muted", padRight(poolDisplayName(pool), 14)))} ${poolStatus}  ${this.theme.fg("dim", `可用 ${readyAccs}/${this.accounts.length} 号`)}`,
            innerWidth,
          ),
        );
        continue;
      }

      const m = row.model;
      const selected = row.idx === this.selectedModelIdx;
      const isActive = m.id === activeModelId;
      const curChoice =
        this.modelThinkingSelection.get(m.id) ??
        (isActive ? activeThinking : catalog.routing[m.id]?.defaultRequestId?.split("-").at(-1)) ??
        "high";

      const pills = ALL_THINKING_LEVELS.map(({ level, label }) => {
        const supported = Boolean(m.thinkingLevelMap && m.thinkingLevelMap[level] !== null && m.thinkingLevelMap[level] !== undefined);
        if (!supported) return this.theme.fg("borderMuted", padRight(`  ${g.offDot}`, 5));
        const token =
          level === "low"
            ? "thinkingLow"
            : level === "medium"
              ? "thinkingMedium"
              : level === "high"
                ? "thinkingHigh"
                : "thinkingXhigh";
        const isLevelSelected = selected && curChoice === level;
        const text = padRight(label, 5);
        return isLevelSelected
          ? this.theme.underline(this.theme.bold(this.theme.fg(token, text)))
          : this.theme.fg(token, text);
      }).join(" ");

      const nameW = Math.max(18, innerWidth - 38);
      const nameStr = padRight(cleanModelName(m.name), nameW);
      const ctxStr = padLeft(formatContextShort(m.contextWindow), 5);
      const mark = isActive ? this.theme.fg("success", `${g.check} `) : "  ";
      const lead = selected ? this.theme.fg("accent", g.cursor) : " ";
      const fullRow = padRight(
        `${lead} ${mark}${selected ? this.theme.bold(this.theme.fg("text", nameStr)) : this.theme.fg("text", nameStr)} ${this.theme.fg("muted", ctxStr)}  ${pills}`,
        innerWidth,
      );
      lines.push(selected ? this.theme.bg("selectedBg", fullRow) : fullRow);
    }

    if (showDetail) {
      const selModel = orderedModels[this.selectedModelIdx] ?? orderedModels[0];
      if (selModel) {
        const route = catalog.routing[selModel.id];
        lines.push(this.theme.fg("borderMuted", g.rule.repeat(innerWidth)));
        lines.push(
          ` ${this.theme.bold(this.theme.fg("text", cleanModelName(selModel.name)))}   ${this.theme.fg("accent", `antigravity/${selModel.id}`)}   ${this.theme.fg("dim", `最大输出 ${formatContextShort(selModel.maxTokens)}`)}`,
        );
        const routeEntries = route?.routing
          ? Object.entries(route.routing)
              .filter(([lvl]) => selModel.thinkingLevelMap?.[lvl as ThinkingEffort] !== null)
              .map(([lvl, rt]) => `${lvl} → ${this.showRuntimeIds ? rt : `…-${rt?.split("-").at(-1)}`}`)
              .join("   ")
          : route?.defaultRequestId ?? selModel.id;
        lines.push(` ${this.theme.fg("muted", "档位路由")}  ${this.theme.fg("dim", truncateToWidth(routeEntries, Math.max(20, innerWidth - 14), "…"))}`);
        if (route?.mergedRuntimeIds?.length) {
          lines.push(
            ` ${this.theme.fg("muted", "已合并")}    ${this.theme.fg("dim", truncateToWidth(`${route.mergedRuntimeIds.join(", ")}（备用路由，不重复显示）`, Math.max(20, innerWidth - 14), "…"))}`,
          );
        }
      }
    }

    return lines;
  }

  private buildDiagnosticsRows(): DiagRow[] {
    const now = Date.now();
    const rows: DiagRow[] = [];
    const diag = getLastDiagnostics();
    const credits = getCreditsStatus();
    const catalog = getCurrentAntigravityCatalog();
    const mergedCount = Object.values(catalog.routing).filter(
      (r) => (r.mergedRuntimeIds?.length ?? 0) > 0,
    ).length;

    const enabledCount = this.accounts.filter((a) => a.enabled).length;
    rows.push({
      id: "chk-auth",
      section: "health",
      label: "凭据状态",
      value: `${this.accounts.length} 个账号 · ${enabledCount} 个参与轮转`,
      status: this.accounts.length > 0 ? "ok" : "warn",
      actionHint: this.accounts.length === 0 ? "Enter 添加账号" : undefined,
    });

    for (const acc of this.accounts) {
      if (acc.authStatus !== "ready") {
        rows.push({
          id: `chk-acc-${acc.accountId}`,
          section: "health",
          label: maskEmailAddress(acc.email, this.settings.maskEmails),
          value: acc.authStatus === "needs_verify" ? "需要验证账号" : acc.authStatus === "disabled" ? "账号被停用/受限" : "授权已失效",
          status: acc.authStatus === "needs_verify" ? "warn" : "err",
          actionHint: acc.verifyUrl ? "Enter 打开验证" : "Enter 重新登录",
        });
      }
    }

    rows.push({
      id: "chk-catalog",
      section: "health",
      label: "模型目录",
      value: `${catalog.models.length} 个模型${mergedCount ? ` · 已合并 ${mergedCount} 个重名` : ""}`,
      status: "ok",
      actionHint: "Enter 强制刷新",
    });

    const reqText = diag.resolvedRuntimeModel
      ? `${diag.error ? "失败" : "成功"} · ${diag.latencyMs ?? "?"}ms · ${diag.resolvedRuntimeModel}${diag.maskedEmail ? ` · ${diag.maskedEmail}` : ""}`
      : "本次会话暂无请求";
    rows.push({
      id: "chk-last",
      section: "health",
      label: "最近请求",
      value: reqText,
      status: diag.error ? "warn" : "dim",
    });

    const strategyLabel =
      this.settings.strategy === "sticky"
        ? "粘性优先"
        : this.settings.strategy === "round-robin"
          ? "轮询"
          : "最高余量";
    rows.push({
      id: "set-strategy",
      section: "setting",
      label: "轮转策略",
      value: `‹ ${strategyLabel} ›`,
      note:
        this.settings.strategy === "sticky"
          ? "平时固定当前号以命中缓存，遇限额热切"
          : this.settings.strategy === "round-robin"
            ? "按顺序轮流分发请求"
            : "优先选剩余额度最高的健康账号",
    });

    const noticeLabel = this.settings.switchNotice === "notify" ? "通知" : "静默";
    rows.push({
      id: "set-notice",
      section: "setting",
      label: "切换提示",
      value: `‹ ${noticeLabel} ›`,
      note: "发生热切换时是否通知",
    });

    rows.push({
      id: "set-credits",
      section: "setting",
      label: "AI 积分超额",
      value: `‹ ${credits.enabled ? "开" : "关"} ›`,
      note: credits.source === "env" ? `锁定 · ${credits.detail}` : "仅对已购 Google One AI 积分的账号生效",
      locked: credits.source === "env",
    });

    rows.push({
      id: "set-mask",
      section: "setting",
      label: "邮箱显示",
      value: `‹ ${this.settings.maskEmails ? "脱敏" : "完整"} ›`,
    });

    const glyphLabel =
      this.settings.glyphs === "auto"
        ? "自动"
        : this.settings.glyphs === "unicode"
          ? "Unicode"
          : "ASCII";
    const sampleG = resolveGlyphs(this.settings.glyphs);
    rows.push({
      id: "set-glyphs",
      section: "setting",
      label: "字形",
      value: `‹ ${glyphLabel} ›`,
      note: `${sampleG.dot} ${sampleG.cooling} ${sampleG.err} ${sampleG.barFull} ${sampleG.barHalf}   显示异常时切 ASCII`,
    });

    for (const evt of getFailoverEvents().slice(0, 4)) {
      const from = shortEmail(evt.fromEmail ?? evt.fromAccountId, this.settings.maskEmails);
      const to = shortEmail(evt.toEmail ?? evt.toAccountId, this.settings.maskEmails);
      const untilTxt = evt.cooldownUntil && evt.cooldownUntil > now ? ` · 冷却至 ${formatClockTime(evt.cooldownUntil)}` : "";
      rows.push({
        id: `evt-${evt.at}-${evt.fromAccountId}`,
        section: "event",
        label: formatClockTime(evt.at),
        value: `${from} ⇄ ${to}`,
        note: `${evt.reason}${untilTxt}`,
        status: "dim",
      });
    }

    return rows;
  }

  private renderDiagnosticsBody(
    g: Glyphs,
    innerWidth: number,
    budget: number,
    _now: number,
  ): string[] {
    const rows = this.buildDiagnosticsRows();
    if (this.selectedDiagIdx >= rows.length) this.selectedDiagIdx = Math.max(0, rows.length - 1);

    const lines: string[] = [];
    let lastSection: string | undefined;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.section !== lastSection) {
        lastSection = r.section;
        const secTitle = r.section === "health" ? "体检" : r.section === "setting" ? "设置" : "切换记录";
        lines.push(` ${this.theme.bold(this.theme.fg("muted", secTitle))}`);
      }
      const selected = i === this.selectedDiagIdx;
      const lead = selected ? this.theme.fg("accent", g.cursor) : " ";

      if (r.section === "health") {
        const icon =
          r.status === "ok"
            ? this.theme.fg("success", g.check)
            : r.status === "warn"
              ? this.theme.fg("warning", g.warn)
              : r.status === "err"
                ? this.theme.fg("error", g.err)
                : this.theme.fg("dim", g.offDot);
        const hint = r.actionHint ? this.theme.fg("accent", r.actionHint) : "";
        const left = `${lead} ${icon}  ${this.theme.fg("muted", padRight(r.label, 14))} ${this.theme.fg("text", r.value)}`;
        const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(hint) - 1);
        const line = padRight(`${left}${" ".repeat(gap)}${hint}`, innerWidth);
        lines.push(selected ? this.theme.bg("selectedBg", line) : line);
      } else if (r.section === "setting") {
        const valColor = r.locked ? "dim" : selected ? "accent" : "text";
        const noteStr = r.note ? this.theme.fg("dim", r.note) : "";
        const line = padRight(
          `${lead}  ${this.theme.fg("muted", padRight(r.label, 14))} ${this.theme.fg(valColor, padRight(r.value, 20))}  ${noteStr}`,
          innerWidth,
        );
        lines.push(selected ? this.theme.bg("selectedBg", line) : line);
      } else {
        const line = padRight(
          `${lead}  ${this.theme.fg("dim", padRight(r.label, 7))} ${this.theme.fg("text", padRight(r.value, 24))} ${this.theme.fg("dim", r.note ?? "")}`,
          innerWidth,
        );
        lines.push(selected ? this.theme.bg("selectedBg", line) : line);
      }
    }

    if (lines.length > budget) {
      return lines.slice(0, budget);
    }
    return lines;
  }

  private renderBottomHintLine(g: Glyphs, innerWidth: number): string {
    if (this.flashMessage) {
      const toneColor =
        this.flashMessage.tone === "success"
          ? "success"
          : this.flashMessage.tone === "warning"
            ? "warning"
            : this.flashMessage.tone === "error"
              ? "error"
              : "accent";
      return padRight(` ${this.theme.fg(toneColor, this.flashMessage.text)}`, innerWidth);
    }

    if (this.confirmDeleteId) {
      const target = this.accounts.find((a) => a.accountId === this.confirmDeleteId);
      const next = this.accounts.find((a) => a.accountId !== this.confirmDeleteId && a.enabled);
      const extra = target?.active && next ? ` ${shortEmail(next.email, this.settings.maskEmails)} 将接替` : "";
      const prompt = ` ${this.theme.fg("error", `解绑 ${maskEmailAddress(target?.email, this.settings.maskEmails)}？${extra}`)}  ${this.theme.fg("muted", "y")} ${this.theme.fg("dim", "确认")}  ${this.theme.fg("muted", "其他键")} ${this.theme.fg("dim", "取消")}`;
      return padRight(prompt, innerWidth);
    }

    if (this.loginState?.active) {
      return padRight(
        ` ${this.theme.fg("muted", "Enter")} ${this.theme.fg("dim", "提交回调链接")}  ${this.theme.fg("muted", "o")} ${this.theme.fg("dim", "重开浏览器")}  ${this.theme.fg("muted", "y")} ${this.theme.fg("dim", "复制链接")}  ${this.theme.fg("muted", "Esc")} ${this.theme.fg("dim", "取消")}`,
        innerWidth,
      );
    }

    const hk = (k: string, d: string) => `${this.theme.fg("muted", k)} ${this.theme.fg("dim", d)}`;
    let hints = "";
    if (this.tab === "accounts") {
      const acc = this.filteredAccounts()[this.selectedAccountIdx];
      const enterLabel = acc?.authStatus === "needs_reauth" ? "重新登录" : "设为首选";
      const parts = [hk("Enter", enterLabel), hk("空格", "轮转"), hk("a", "添加"), hk("r", "刷新"), hk("d", "解绑")];
      if (acc && Object.values(acc.poolCooldowns).some((c) => c && c.until > Date.now())) {
        parts.splice(2, 0, hk("x", "清冷却"));
      }
      if (acc?.verifyUrl) parts.splice(2, 0, hk("o", "验证"));
      hints = parts.join("  ");
    } else if (this.tab === "models") {
      hints = [hk("Enter", "使用模型"), hk("←→", "思考档位"), hk("i", "运行时 ID"), hk("/", "筛选")].join("  ");
    } else {
      hints = [hk("Enter", "执行"), hk("←→", "修改设置"), hk("y", "复制诊断")].join("  ");
    }

    const right = this.theme.fg("dim", "Esc 关闭");
    const gap = Math.max(1, innerWidth - visibleWidth(hints) - visibleWidth(right) - 2);
    return padRight(` ${hints}${" ".repeat(gap)}${right}`, innerWidth);
  }

  handleInput(data: string): void {
    if (this.disposed) return;

    if (this.loginState?.active) {
      this.loginState.handleInput(data);
      return;
    }

    if (this.confirmDeleteId) {
      const targetId = this.confirmDeleteId;
      this.confirmDeleteId = undefined;
      if (data === "y" || data === "Y") {
        void removeAccount(targetId)
          .then((next) => {
            this.reloadData();
            this.setFlash(
              next ? `已解绑，${shortEmail(next.email, this.settings.maskEmails)} 已接替` : "已解绑账号",
              "info",
            );
          })
          .catch((e) => this.setFlash(`解绑失败：${e instanceof Error ? e.message : String(e)}`, "error"));
      } else {
        this.tui.requestRender();
      }
      return;
    }

    if (this.searching) {
      if (matchesKey(data, Key.escape)) {
        this.searching = false;
        this.searchInput.focused = false;
        this.tui.requestRender();
        return;
      }
      this.searchInput.handleInput(data);
      this.filterQuery = this.searchInput.getValue().trim();
      this.selectedAccountIdx = 0;
      this.selectedModelIdx = 0;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.close();
      return;
    }

    if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      if (this.filterQuery) {
        this.filterQuery = "";
        this.searchInput.setValue("");
        this.tui.requestRender();
        return;
      }
      if (this.compactDetailOpen) {
        this.compactDetailOpen = false;
        this.tui.requestRender();
        return;
      }
      this.close();
      return;
    }

    if (data === "/") {
      this.searching = true;
      this.searchInput.focused = true;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.tab) || data === "1" || data === "2" || data === "3") {
      if (data === "1") this.switchTab("accounts");
      else if (data === "2") this.switchTab("models");
      else if (data === "3") this.switchTab("diagnostics");
      else {
        const order: ConsoleTab[] = ["accounts", "models", "diagnostics"];
        const next = order[(order.indexOf(this.tab) + 1) % order.length]!;
        this.switchTab(next);
      }
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      const order: ConsoleTab[] = ["accounts", "models", "diagnostics"];
      const prev = order[(order.indexOf(this.tab) - 1 + order.length) % order.length]!;
      this.switchTab(prev);
      return;
    }

    if (data === "r" || data === "R") {
      this.triggerRefreshAll();
      return;
    }

    if (this.tab === "accounts") {
      this.handleAccountsInput(data);
    } else if (this.tab === "models") {
      this.handleModelsInput(data);
    } else {
      this.handleDiagnosticsInput(data);
    }
  }

  private handleAccountsInput(data: string): void {
    const accounts = this.filteredAccounts();
    const cur = accounts[this.selectedAccountIdx];

    if (matchesKey(data, Key.shift("up")) || data === "K") {
      if (cur && moveAccountOrder(cur.accountId, -1)) {
        this.selectedAccountIdx = Math.max(0, this.selectedAccountIdx - 1);
        this.reloadData();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.shift("down")) || data === "J") {
      if (cur && moveAccountOrder(cur.accountId, 1)) {
        this.selectedAccountIdx = Math.min(accounts.length - 1, this.selectedAccountIdx + 1);
        this.reloadData();
        this.tui.requestRender();
      }
      return;
    }

    if (this.kb.matches(data, "tui.select.up") || data === "k") {
      if (accounts.length) {
        this.selectedAccountIdx = (this.selectedAccountIdx - 1 + accounts.length) % accounts.length;
        this.tui.requestRender();
      }
      return;
    }
    if (this.kb.matches(data, "tui.select.down") || data === "j") {
      if (accounts.length) {
        this.selectedAccountIdx = (this.selectedAccountIdx + 1) % accounts.length;
        this.tui.requestRender();
      }
      return;
    }

    if (data === "a" || data === "A") {
      this.openInlineLogin();
      return;
    }

    if (data === "c" || data === "C") {
      this.toggleCreditsFromUi();
      return;
    }

    if (!cur) return;

    if (data === " ") {
      const res = toggleAccountRotation(cur.accountId);
      if (!res.ok) {
        this.setFlash(res.error, "warning");
      } else {
        this.reloadData();
        this.setFlash(res.enabled ? "已恢复参与轮转" : "已暂停轮转", "info");
      }
      return;
    }

    if (data === "d" || data === "D") {
      this.confirmDeleteId = cur.accountId;
      this.tui.requestRender();
      return;
    }

    if (data === "x" || data === "X") {
      if (clearAccountCooldown(cur.accountId)) {
        this.reloadData();
        this.setFlash("已手动解除冷却", "success");
      }
      return;
    }

    if (data === "o" || data === "O") {
      if (cur.verifyUrl) {
        openUrlInBrowser(cur.verifyUrl);
        this.setFlash("已在浏览器打开验证链接", "info");
      }
      return;
    }

    if (matchesKey(data, Key.right) || data === "l") {
      this.compactDetailOpen = !this.compactDetailOpen;
      this.tui.requestRender();
      return;
    }

    if (this.kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      if (cur.authStatus === "needs_reauth") {
        this.openInlineLogin();
        return;
      }
      void promoteAccountToPrimary(cur.accountId)
        .then((acc) => {
          this.reloadData();
          this.selectedAccountIdx = 0;
          const now = Date.now();
          const anyCooling = Object.entries(cur.poolCooldowns).find(([, cd]) => cd && cd.until > now);
          if (anyCooling) {
            const [pool, cd] = anyCooling;
            this.setFlash(
              `已设为首选；${poolDisplayName(pool as QuotaPoolKey)} 池冷却中 (${formatClockTime(cd!.until)} 恢复)`,
              "warning",
            );
          } else {
            this.setFlash(`已切换为首选 · ${shortEmail(acc.email, this.settings.maskEmails)}`, "success");
          }
        })
        .catch((e) => {
          this.setFlash(`切换失败：${e instanceof Error ? e.message : String(e)}`, "error");
        });
    }
  }

  private handleModelsInput(data: string): void {
    const models = this.filteredModels();
    const poolsOrder: QuotaPoolKey[] = ["gemini", "argon", "claude_gpt"];
    const orderedModels: AntigravityModelConfig[] = [];
    for (const pool of poolsOrder) {
      for (const m of models) {
        if (poolKeyForModel(m.id) === pool) orderedModels.push(m);
      }
    }
    if (!orderedModels.length) return;
    if (this.selectedModelIdx >= orderedModels.length) this.selectedModelIdx = 0;

    if (this.kb.matches(data, "tui.select.up") || data === "k") {
      this.selectedModelIdx = (this.selectedModelIdx - 1 + orderedModels.length) % orderedModels.length;
      this.tui.requestRender();
      return;
    }
    if (this.kb.matches(data, "tui.select.down") || data === "j") {
      this.selectedModelIdx = (this.selectedModelIdx + 1) % orderedModels.length;
      this.tui.requestRender();
      return;
    }

    const cur = orderedModels[this.selectedModelIdx]!;
    const supported = ALL_THINKING_LEVELS.map((l) => l.level).filter(
      (lvl) => cur.thinkingLevelMap && cur.thinkingLevelMap[lvl] !== null && cur.thinkingLevelMap[lvl] !== undefined,
    );

    if (matchesKey(data, Key.left) || data === "h" || matchesKey(data, Key.right) || data === "l") {
      if (supported.length > 1) {
        const curLvl = this.modelThinkingSelection.get(cur.id) ?? supported[0]!;
        const idx = supported.indexOf(curLvl as any);
        const delta = matchesKey(data, Key.left) || data === "h" ? -1 : 1;
        const next = supported[(Math.max(0, idx) + delta + supported.length) % supported.length]!;
        this.modelThinkingSelection.set(cur.id, next);
        this.tui.requestRender();
      }
      return;
    }

    if (data === "i" || data === "I") {
      this.showRuntimeIds = !this.showRuntimeIds;
      this.tui.requestRender();
      return;
    }

    if (this.kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const targetModel = this.ctx.modelRegistry.find(PROVIDER_ID, cur.id);
      if (!targetModel) {
        this.setFlash("未在模型注册表中找到该模型，请先按 r 或 /agy refresh", "warning");
        return;
      }
      const chosenLvl = this.modelThinkingSelection.get(cur.id) ?? supported[0];
      void this.pi.setModel(targetModel).then((ok) => {
        if (!ok) {
          this.setFlash("切换模型失败，请检查账号凭据", "error");
          return;
        }
        if (chosenLvl && targetModel.reasoning) {
          this.pi.setThinkingLevel(chosenLvl as ThinkingEffort);
        }
        this.setFlash(`已切换至 ${cleanModelName(cur.name)}${chosenLvl ? ` · ${chosenLvl}` : ""}`, "success");
      });
    }
  }

  private handleDiagnosticsInput(data: string): void {
    const rows = this.buildDiagnosticsRows();
    if (!rows.length) return;
    if (this.kb.matches(data, "tui.select.up") || data === "k") {
      this.selectedDiagIdx = (this.selectedDiagIdx - 1 + rows.length) % rows.length;
      this.tui.requestRender();
      return;
    }
    if (this.kb.matches(data, "tui.select.down") || data === "j") {
      this.selectedDiagIdx = (this.selectedDiagIdx + 1) % rows.length;
      this.tui.requestRender();
      return;
    }

    if (data === "y" || data === "Y") {
      const diag = getLastDiagnostics();
      const payload = JSON.stringify(
        {
          accounts: this.accounts.length,
          enabled: this.accounts.filter((a) => a.enabled).length,
          settings: this.settings,
          lastRequest: diag,
        },
        null,
        2,
      );
      const ok = copyToClipboard(payload);
      this.setFlash(ok ? "已复制脱敏诊断信息" : "复制失败", ok ? "success" : "warning");
      return;
    }

    const row = rows[this.selectedDiagIdx];
    if (!row) return;

    const isLeft = matchesKey(data, Key.left) || data === "h";
    const isRight = matchesKey(data, Key.right) || data === "l";
    const isEnter = this.kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter);

    if (row.section === "setting" && (isLeft || isRight || isEnter)) {
      const dir = isLeft ? -1 : 1;
      if (row.id === "set-strategy") {
        const opts = ["sticky", "round-robin", "max-quota"] as const;
        const next = opts[(opts.indexOf(this.settings.strategy) + dir + opts.length) % opts.length]!;
        this.settings = saveAntigravitySettings({ strategy: next });
      } else if (row.id === "set-notice") {
        const next = this.settings.switchNotice === "notify" ? "silent" : "notify";
        this.settings = saveAntigravitySettings({ switchNotice: next });
      } else if (row.id === "set-credits") {
        this.toggleCreditsFromUi();
      } else if (row.id === "set-mask") {
        this.settings = saveAntigravitySettings({ maskEmails: !this.settings.maskEmails });
      } else if (row.id === "set-glyphs") {
        const opts = ["auto", "unicode", "ascii"] as const;
        const next = opts[(opts.indexOf(this.settings.glyphs) + dir + opts.length) % opts.length]!;
        this.settings = saveAntigravitySettings({ glyphs: next });
      }
      this.tui.requestRender();
      return;
    }

    if (row.section === "health" && isEnter) {
      if (row.id === "chk-auth") {
        this.openInlineLogin();
      } else if (row.id.startsWith("chk-acc-")) {
        const accId = row.id.slice("chk-acc-".length);
        const acc = this.accounts.find((a) => a.accountId === accId);
        if (acc?.verifyUrl) {
          openUrlInBrowser(acc.verifyUrl);
          this.setFlash("已在浏览器打开验证链接", "info");
        } else {
          this.openInlineLogin();
        }
      } else if (row.id === "chk-catalog") {
        void this.ctx.modelRegistry
          .refresh({ force: true, providers: [PROVIDER_ID] })
          .then(() => {
            this.setFlash(`模型目录已同步 · ${getCurrentAntigravityCatalog().models.length} 个`, "success");
          })
          .catch((e) => {
            this.setFlash(`刷新失败：${e instanceof Error ? e.message : String(e)}`, "error");
          });
      }
    }
  }

  private toggleCreditsFromUi(): void {
    const status = getCreditsStatus();
    if (status.source === "env") {
      this.setFlash(`积分超额已被环境变量锁定 (${status.detail})`, "warning");
      return;
    }
    setCreditsEnabled(!status.enabled);
    this.setFlash(`AI 积分超额已${!status.enabled ? "开启" : "关闭"}`, "info");
  }

  private refreshCatalogAfterAuth(promoteLatestIfStale: boolean): void {
    const refreshPromise =
      typeof this.ctx.modelRegistry?.refresh === "function"
        ? this.ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true })
        : undefined;
    if (!refreshPromise) return;
    void refreshPromise
      .then(async () => {
        if (this.disposed) return;
        this.reloadData();
        if (promoteLatestIfStale) {
          const cur = this.ctx.model;
          const isStaleOrUnset =
            !cur || (cur.provider === PROVIDER_ID && STALE_STATIC_FALLBACK_IDS.has(cur.id));
          if (isStaleOrUnset) {
            const available = this.ctx.modelRegistry
              .getAvailable()
              .filter((m) => m.provider === PROVIDER_ID);
            const preferred =
              available.find((m) => m.id === "gemini-4-hydrogen") ??
              available.find((m) => m.id === "gemini-4-neon") ??
              available.find((m) => m.id.startsWith("gemini-4")) ??
              available[0];
            if (preferred && (!cur || cur.id !== preferred.id)) {
              await this.pi.setModel(preferred).catch(() => {});
            }
          }
        }
        this.setFlash(`模型目录已同步 · ${getCurrentAntigravityCatalog().models.length} 个`, "success");
      })
      .catch(() => {});
  }

  private openInlineLogin(): void {
    this.loginState = startInlineLogin({
      onUpdate: () => this.tui.requestRender(),
      onSuccess: (creds) => {
        this.loginState = undefined;
        this.reloadData();
        void activateAccount(creds.email ?? "")
          .catch(() => {})
          .finally(() => {
            this.refreshCatalogAfterAuth(true);
          });
        this.setFlash(`已登录 ${shortEmail(creds.email, this.settings.maskEmails)}，正在同步最新模型…`, "success");
        this.triggerRefreshAll();
      },
      onCancel: () => {
        this.loginState = undefined;
        this.tui.requestRender();
      },
      onMessage: (text, tone) => this.setFlash(text, tone),
    });
    this.tui.requestRender();
  }
}

function renderBox(
  theme: Theme,
  g: Glyphs,
  title: string,
  rightMeta: string,
  bodyLines: string[],
  innerWidth: number,
): string[] {
  const titlePart = ` ${title} `;
  const metaPart = rightMeta ? ` ${rightMeta} ` : "";
  const fillCount = Math.max(1, innerWidth - visibleWidth(titlePart) - visibleWidth(metaPart) - 2);
  const topLine =
    theme.fg("border", `${g.tl}${g.rule}`) +
    theme.bold(theme.fg("accent", titlePart)) +
    theme.fg("border", g.rule.repeat(fillCount)) +
    (metaPart ? theme.fg("muted", metaPart) : "") +
    theme.fg("border", `${g.rule}${g.tr}`);
  const bottomLine = theme.fg("border", `${g.bl}${g.rule.repeat(innerWidth)}${g.br}`);
  const side = theme.fg("border", g.v);
  return [
    topLine,
    ...bodyLines.map((line) => `${side}${padRight(line, innerWidth)}${side}`),
    bottomLine,
  ];
}
