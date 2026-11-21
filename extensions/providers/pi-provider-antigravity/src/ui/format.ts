import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AccountSummary } from "../auth/accounts.js";
import type {
  AntigravityModelConfig,
  AntigravityRouting,
  AntigravitySettings,
  GlyphMode,
  QuotaPoolKey,
} from "../types/types.js";
import type { DiagnosticsSnapshot } from "../diagnostics/diagnostics.js";

export type Glyphs = {
  ascii: boolean;
  dot: string;
  cooling: string;
  err: string;
  warn: string;
  paused: string;
  primary: string;
  barFull: string;
  barHalf: string;
  barEmpty: string;
  swap: string;
  check: string;
  offDot: string;
  cursor: string;
  rule: string;
  activeRule: string;
  tl: string;
  tr: string;
  bl: string;
  br: string;
  v: string;
  spinner: readonly string[];
};

const UNICODE_GLYPHS: Glyphs = {
  ascii: false,
  dot: "●",
  cooling: "◐",
  err: "✕",
  warn: "!",
  paused: "○",
  primary: "◆",
  barFull: "━",
  barHalf: "╸",
  barEmpty: "─",
  swap: "⇄",
  check: "✓",
  offDot: "·",
  cursor: "▌",
  rule: "─",
  activeRule: "━",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  v: "│",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII_GLYPHS: Glyphs = {
  ascii: true,
  dot: "*",
  cooling: "~",
  err: "x",
  warn: "!",
  paused: "o",
  primary: ">",
  barFull: "=",
  barHalf: "-",
  barEmpty: ".",
  swap: "<>",
  check: "+",
  offDot: ".",
  cursor: "|",
  rule: "-",
  activeRule: "=",
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  v: "|",
  spinner: ["-", "\\", "|", "/"],
};

export function resolveGlyphs(mode: GlyphMode): Glyphs {
  if (mode === "ascii") return ASCII_GLYPHS;
  return UNICODE_GLYPHS;
}

export function padRight(text: string, targetWidth: number): string {
  const clipped = truncateToWidth(text, targetWidth, "…");
  const w = visibleWidth(clipped);
  return w >= targetWidth ? clipped : `${clipped}${" ".repeat(targetWidth - w)}`;
}

export function padLeft(text: string, targetWidth: number): string {
  const clipped = truncateToWidth(text, targetWidth, "…");
  const w = visibleWidth(clipped);
  return w >= targetWidth ? clipped : `${" ".repeat(targetWidth - w)}${clipped}`;
}

export function maskEmailAddress(email: string | undefined, mask: boolean): string {
  if (!email) return "未知账号";
  if (!mask) return email;
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = local.length <= 2 ? 1 : Math.min(5, Math.max(2, Math.ceil(local.length / 2)));
  return `${local.slice(0, keep)}***${domain}`;
}

export function shortEmail(email: string | undefined, mask: boolean): string {
  if (!email) return "未知";
  const masked = maskEmailAddress(email, mask);
  const at = masked.indexOf("@");
  return at > 0 ? masked.slice(0, at) : masked;
}

export function tierBadge(planLabel?: string): { label: string; kind: "ultra" | "pro" | "free" } {
  const s = (planLabel ?? "").toLowerCase();
  if (s.includes("ultra")) return { label: "ULTRA", kind: "ultra" };
  if (s.includes("pro")) return { label: "PRO", kind: "pro" };
  if (s.includes("enterprise")) return { label: "ENT", kind: "ultra" };
  if (s.includes("free")) return { label: "FREE", kind: "free" };
  return planLabel ? { label: planLabel.slice(0, 5).toUpperCase(), kind: "pro" } : { label: "—", kind: "free" };
}

export function formatCountdown(targetMs: number, now = Date.now(), estimated = false): string {
  const delta = Math.max(0, targetMs - now);
  if (delta <= 0) return "即将恢复";
  const prefix = estimated ? "≈" : "";
  const totalSec = Math.ceil(delta / 1000);
  if (totalSec < 60) return `${prefix}${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    return `${prefix}${String(totalMin).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  const totalHours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHours < 24) {
    return `${prefix}${totalHours}h${String(mins).padStart(2, "0")}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${prefix}${days}d${hours}h`;
}

export function formatResetIso(resetIso: string | undefined, now = Date.now()): string {
  if (!resetIso) return "未知";
  const ts = Date.parse(resetIso);
  if (!Number.isFinite(ts)) return resetIso;
  if (ts <= now) return "即将重置";
  const delta = ts - now;
  const totalMin = Math.round(delta / 60_000);
  if (totalMin < 60) return `${Math.max(1, totalMin)}m 后重置`;
  const totalHours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHours < 24) return `${totalHours}h${String(mins).padStart(2, "0")}m 后重置`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days} 天 ${hours}h 后重置` : `${days} 天后重置`;
}

export function formatClockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatRelativeAge(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "未同步";
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 10) return "刚刚";
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hrs = Math.floor(min / 60);
  return `${hrs} 小时前`;
}

export function formatContextShort(tokens?: number): string {
  if (!tokens || tokens <= 0) return "—";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function quotaColor(theme: Theme, fraction: number): "success" | "warning" | "error" {
  if (fraction >= 0.5) return "success";
  if (fraction >= 0.2) return "warning";
  return "error";
}

export function renderQuotaBar(
  theme: Theme,
  g: Glyphs,
  fraction: number | undefined,
  barWidth: number,
  dimmed = false,
): string {
  if (fraction === undefined) {
    return theme.fg("dim", padRight("—", barWidth));
  }
  const clamped = Math.max(0, Math.min(1, fraction));
  const halfUnits = Math.round(clamped * barWidth * 2);
  const full = Math.floor(halfUnits / 2);
  const hasHalf = halfUnits % 2 === 1;
  const empty = Math.max(0, barWidth - full - (hasHalf ? 1 : 0));
  const filledStr = `${g.barFull.repeat(full)}${hasHalf ? g.barHalf : ""}`;
  const emptyStr = g.barEmpty.repeat(empty);
  const color = dimmed ? "dim" : quotaColor(theme, clamped);
  return `${theme.fg(color, filledStr)}${theme.fg("borderMuted", emptyStr)}`;
}

export function renderPoolCell(
  theme: Theme,
  g: Glyphs,
  account: AccountSummary,
  pool: QuotaPoolKey,
  barWidth: number,
  cellWidth: number,
  loadingFrame: string | undefined,
  now = Date.now(),
): string {
  const cd = account.poolCooldowns[pool];
  const dimmed = !account.enabled;
  if (cd && cd.until > now) {
    const label = `${g.cooling} ${formatCountdown(cd.until, now, cd.estimated)}`;
    const content = loadingFrame ? `${theme.fg("muted", loadingFrame)} ${label}` : label;
    return theme.fg(dimmed ? "dim" : "warning", padRight(content, cellWidth));
  }
  const quota = account.cachedUsage?.pools[pool];
  const frac = quota?.remaining ?? quota?.remaining5h ?? quota?.remainingWeekly;
  if (account.cachedUsage?.error && frac === undefined) {
    return theme.fg("error", padRight(`${g.warn} 拉取失败`, cellWidth));
  }
  if (frac === undefined) {
    if (loadingFrame) return theme.fg("accent", padRight(loadingFrame, cellWidth));
    return theme.fg("dim", padRight("—", cellWidth));
  }
  if (frac <= 0) {
    const reset = quota?.resetTime ? ` · ${formatCountdown(Date.parse(quota.resetTime), now)}` : "";
    return theme.fg(dimmed ? "dim" : "error", padRight(`耗尽${reset}`, cellWidth));
  }

  const pctNum = Math.round(frac * 100);
  const pctText = `${String(pctNum).padStart(3)}%`;
  const pctStyled = dimmed
    ? theme.fg("dim", pctText)
    : frac < 0.2
      ? theme.fg("error", pctText)
      : frac < 0.5
        ? theme.fg("warning", pctText)
        : `${theme.fg("text", String(pctNum).padStart(3))}${theme.fg("dim", "%")}`;

  if (barWidth <= 0) {
    const spin = loadingFrame ? `${theme.fg("muted", loadingFrame)} ` : "";
    return padRight(`${spin}${pctStyled}`, cellWidth);
  }

  const bar = renderQuotaBar(theme, g, frac, barWidth, dimmed || Boolean(loadingFrame));
  const spin = loadingFrame ? theme.fg("accent", `${loadingFrame} `) : "";
  return padRight(`${spin}${bar} ${pctStyled}`, cellWidth);
}

export function renderRoundedFrame(
  theme: Theme,
  g: Glyphs,
  title: string,
  rightMeta: string,
  bodyLines: string[],
  innerWidth: number,
  borderColor: "border" | "accent" | "borderMuted" = "border",
): string[] {
  const totalWidth = innerWidth + 2;
  const titleText = ` ${title} `;
  const metaText = rightMeta ? ` ${rightMeta} ` : "";
  const titleW = visibleWidth(titleText);
  const metaW = visibleWidth(metaText);
  const fillCount = Math.max(2, totalWidth - 2 - titleW - metaW - 1);
  const topLine =
    theme.fg(borderColor, `${g.tl}${g.rule}`) +
    theme.bold(theme.fg("accent", titleText)) +
    theme.fg(borderColor, g.rule.repeat(fillCount)) +
    (metaText ? theme.fg("muted", metaText) : "") +
    theme.fg(borderColor, `${g.rule}${g.tr}`);

  const bottomLine = theme.fg(borderColor, `${g.bl}${g.rule.repeat(totalWidth - 2)}${g.br}`);
  const side = theme.fg(borderColor, g.v);
  const wrapped = bodyLines.map((line) => `${side}${padRight(line, innerWidth)}${side}`);
  return [topLine, ...wrapped, bottomLine];
}

export function accountStatusText(
  account: AccountSummary,
  now = Date.now(),
): { glyphKey: "dot" | "cooling" | "err" | "warn" | "paused"; text: string; color: "accent" | "success" | "warning" | "error" | "dim" | "muted" } {
  if (!account.enabled) {
    return { glyphKey: "paused", text: "已暂停", color: "dim" };
  }
  if (account.authStatus === "needs_reauth") {
    return { glyphKey: "err", text: "需重登", color: "error" };
  }
  if (account.authStatus === "disabled") {
    return { glyphKey: "err", text: "已停用", color: "error" };
  }
  if (account.authStatus === "needs_verify") {
    return { glyphKey: "warn", text: "需验证", color: "warning" };
  }
  const pools: QuotaPoolKey[] = ["gemini", "claude_gpt"];
  const allCooling = pools.every((p) => {
    const cd = account.poolCooldowns[p];
    return cd && cd.until > now;
  });
  if (allCooling) {
    return { glyphKey: "cooling", text: "冷却", color: "warning" };
  }
  if (account.active) {
    return { glyphKey: "dot", text: "使用中", color: "accent" };
  }
  return { glyphKey: "dot", text: "就绪", color: "success" };
}

export function cleanModelName(name: string): string {
  return name.replace(/\s*\(Antigravity\)$/i, "").replace(/\bGpt-Oss\b/g, "GPT-OSS");
}

export function formatAccountsPlainText(
  accounts: AccountSummary[],
  settings: AntigravitySettings,
  now = Date.now(),
): string {
  if (!accounts.length) return "未绑定 Antigravity 账号，请运行 /login antigravity 登录。";
  const headers = ["#", "账号", "套餐", "状态", "Gemini", "Claude/GPT", "积分"];
  const rows = accounts.map((acc, i) => {
    const st = accountStatusText(acc, now);
    const badge = tierBadge(acc.planLabel).label;
    const fmtPool = (pool: QuotaPoolKey): string => {
      const cd = acc.poolCooldowns[pool];
      if (cd && cd.until > now) return `冷却 ${formatCountdown(cd.until, now, cd.estimated)}`;
      const q = acc.cachedUsage?.pools[pool];
      const frac = q?.remaining ?? q?.remaining5h ?? q?.remainingWeekly;
      if (frac === undefined) return "-";
      const pct = `${Math.round(frac * 100)}%`;
      const rst = q?.resetTime ? ` ↻${formatCountdown(Date.parse(q.resetTime), now)}` : "";
      return `${pct}${rst}`;
    };
    const credits =
      acc.cachedUsage?.credits !== undefined ? acc.cachedUsage.credits.toLocaleString() : "-";
    return [
      acc.enabled ? String(i + 1) : "-",
      maskEmailAddress(acc.email, settings.maskEmails),
      badge,
      st.text,
      fmtPool("gemini"),
      fmtPool("claude_gpt"),
      credits,
    ];
  });
  return renderPlainTable(headers, rows);
}

export function formatModelsPlainText(
  models: AntigravityModelConfig[],
  routing: Record<string, AntigravityRouting>,
): string {
  if (!models.length) return "暂无可用模型。";
  const headers = ["模型", "ID", "上下文", "思考档位", "已合并"];
  const rows = models.map((m) => {
    const r = routing[m.id];
    const levels = m.thinkingLevelMap
      ? Object.entries(m.thinkingLevelMap)
          .filter(([, v]) => v !== null)
          .map(([k]) => k)
          .join("/")
      : "-";
    const merged = r?.mergedRuntimeIds?.length ? `${r.mergedRuntimeIds.length} 个 tiered` : "-";
    return [cleanModelName(m.name), m.id, formatContextShort(m.contextWindow), levels || "-", merged];
  });
  return renderPlainTable(headers, rows);
}

export function formatDiagnosticsPlainText(
  accounts: AccountSummary[],
  modelsCount: number,
  diag: Readonly<DiagnosticsSnapshot>,
  settings: AntigravitySettings,
): string {
  const active = accounts.find((a) => a.active);
  const lines = [
    `Antigravity 诊断`,
    `账号总数: ${accounts.length} (参与轮转 ${accounts.filter((a) => a.enabled).length})`,
    `当前账号: ${active ? maskEmailAddress(active.email, settings.maskEmails) : "无"}`,
    `轮转策略: ${settings.strategy}`,
    `模型数量: ${modelsCount}`,
    `最近模型: ${diag.resolvedRuntimeModel || "无"}`,
    `最近端点: ${diag.endpoint || "无"}`,
    `最近状态: ${diag.status ?? "无"}`,
    `最近延迟: ${diag.latencyMs !== undefined ? `${diag.latencyMs}ms` : "无"}`,
    `最近错误: ${diag.error || "无"}`,
  ];
  return lines.join("\n");
}

function renderPlainTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, idx) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[idx] ?? ""))),
  );
  const fmtRow = (cols: string[]) =>
    cols.map((c, idx) => padRight(c, widths[idx] ?? 0)).join("  ").trimEnd();
  return [fmtRow(headers), ...rows.map(fmtRow)].join("\n");
}
