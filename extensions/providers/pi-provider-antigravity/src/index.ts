import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import {
  activateAccount,
  getApiKey,
  getLastFailoverEvent,
  listAccounts,
  loginAntigravity,
  onAccountsChanged,
  refreshAntigravityToken,
  rememberAccount,
  removeAccount,
  updateRememberedAccount,
} from "./auth/index.js";
import { DEFAULT_ENDPOINT } from "./client/index.js";
import { getLastDiagnostics } from "./diagnostics/index.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshAntigravityModels,
  resolvedCatalog,
} from "./models/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import { openAntigravityConsole, type ConsoleTab } from "./ui/console.js";
import {
  formatAccountsPlainText,
  formatDiagnosticsPlainText,
  formatModelsPlainText,
  shortEmail,
} from "./ui/format.js";
import { refreshAllAccountsUsage, resolveApiKeyFromContext } from "./usage/index.js";
import { getCreditsStatus, redactSecrets, setCreditsEnabled } from "./utils/index.js";
import { loadAntigravitySettings } from "./utils/settings.js";

function emitText(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

async function loginAndRemember(
  callbacks: Parameters<typeof loginAntigravity>[0],
): ReturnType<typeof loginAntigravity> {
  const credentials = await loginAntigravity(callbacks);
  rememberAccount(credentials);
  return credentials;
}

async function refreshAndRemember(
  credentials: Parameters<typeof refreshAntigravityToken>[0],
): ReturnType<typeof refreshAntigravityToken> {
  const refreshed = await refreshAntigravityToken(credentials);
  updateRememberedAccount(credentials, refreshed);
  return refreshed;
}

type CompatApiProviderRegistrar = (provider: {
  api: typeof ANTIGRAVITY_API;
  stream: typeof streamAntigravity;
  streamSimple: typeof streamAntigravity;
}) => void;

function registerCompatApiProvider(): void {
  const register = (piAiCompat as { registerApiProvider?: CompatApiProviderRegistrar })
    .registerApiProvider;
  if (typeof register === "function") {
    register({
      api: ANTIGRAVITY_API,
      stream: streamAntigravity,
      streamSimple: streamAntigravity,
    });
  }
}

export default function (pi: ExtensionAPI): void {
  registerCompatApiProvider();

  let activeCtx: ExtensionContext | undefined;
  let unsubAccounts: (() => void) | undefined;
  let lastSeenFailoverAt = getLastFailoverEvent()?.at ?? 0;
  let lastNotifyAt = 0;

  const cleanupListeners = (): void => {
    unsubAccounts?.();
    unsubAccounts = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    cleanupListeners();

    if (typeof ctx.ui?.setStatus === "function") {
      ctx.ui.setStatus(PROVIDER_ID, undefined);
    }

    unsubAccounts = onAccountsChanged(() => {
      const evt = getLastFailoverEvent();
      const settings = loadAntigravitySettings();
      if (evt && evt.at > lastSeenFailoverAt) {
        lastSeenFailoverAt = evt.at;
        const now = Date.now();
        if (
          activeCtx?.hasUI &&
          typeof activeCtx.ui?.notify === "function" &&
          settings.switchNotice === "notify" &&
          now - lastNotifyAt >= 60_000
        ) {
          lastNotifyAt = now;
          const to = shortEmail(evt.toEmail ?? evt.toAccountId, settings.maskEmails);
          const from = shortEmail(evt.fromEmail ?? evt.fromAccountId, settings.maskEmails);
          activeCtx.ui.notify(`已热切换到 ${to}（${from}：${evt.reason}）`, "info");
        }
      }
    });

    if (process.env.PI_OFFLINE !== undefined) return;
    if (typeof ctx.modelRegistry?.refresh !== "function") return;
    try {
      const refresh = ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
      if (ctx.hasUI) void refresh.catch(() => {});
      else await refresh;
    } catch {
      // Keep last-known-good catalog.
    }
  });

  pi.on("session_shutdown", () => {
    cleanupListeners();
    activeCtx = undefined;
  });

  const initialCatalog = getCurrentAntigravityCatalog();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: initialCatalog.models,
    refreshModels: refreshAntigravityModels,
    oauth: {
      name: PROVIDER_NAME,
      isSubscription: true,
      login: loginAndRemember,
      refreshToken: refreshAndRemember,
      getApiKey,
    },
    streamSimple: streamAntigravity,
  });

  const runRefreshCatalog = async (ctx: ExtensionCommandContext): Promise<void> => {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      emitText(ctx, "未检测到 Antigravity 登录凭据，请先运行 /login antigravity", "warning");
      return;
    }
    const before = getCurrentAntigravityCatalog().models.length;
    try {
      if (typeof ctx.modelRegistry?.refresh === "function") {
        const result = await ctx.modelRegistry.refresh({
          force: true,
          providers: [PROVIDER_ID],
        });
        if (result?.errors?.has(PROVIDER_ID)) {
          throw result.errors.get(PROVIDER_ID)!;
        }
      } else {
        const discovered = await discoverAntigravityModels(apiKey);
        const next = resolvedCatalog(discovered, getCurrentAntigravityCatalog());
        if (discovered.models.length > 0) applyAntigravityCatalog(next);
      }
      const after = getCurrentAntigravityCatalog().models.length;
      const diff = after - before;
      const diffLabel = diff === 0 ? "" : diff > 0 ? ` (+${diff})` : ` (${diff})`;
      emitText(ctx, `模型目录已同步 · ${after} 个${diffLabel}`, "info");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emitText(ctx, `模型目录同步失败：${redactSecrets(msg)}`, "error");
    }
  };

  const openOrPrint = async (
    ctx: ExtensionCommandContext,
    tab: ConsoleTab,
    opts: { refreshOnOpen?: boolean; focusCredits?: boolean; json?: boolean } = {},
  ): Promise<void> => {
    if (ctx.hasUI && !opts.json) {
      await openAntigravityConsole(pi, ctx, {
        initialTab: tab,
        refreshOnOpen: opts.refreshOnOpen,
        focusCredits: opts.focusCredits,
      });
      return;
    }

    if (tab === "accounts" && opts.refreshOnOpen) {
      await refreshAllAccountsUsage();
    }
    const settings = loadAntigravitySettings();
    const accounts = listAccounts();
    const catalog = getCurrentAntigravityCatalog();
    const diag = getLastDiagnostics();

    if (opts.json) {
      const payload =
        tab === "accounts"
          ? {
              accounts: accounts.map((a) => ({
                accountId: a.accountId,
                email: a.email,
                active: a.active,
                enabled: a.enabled,
                order: a.order,
                planLabel: a.planLabel,
                authStatus: a.authStatus,
                poolCooldowns: a.poolCooldowns,
                cachedUsage: a.cachedUsage,
              })),
            }
          : tab === "models"
            ? { models: catalog.models, routing: catalog.routing }
            : { accountsCount: accounts.length, settings, lastRequest: diag };
      emitText(ctx, JSON.stringify(payload, null, 2));
      return;
    }

    if (tab === "accounts") {
      emitText(ctx, formatAccountsPlainText(accounts, settings));
    } else if (tab === "models") {
      emitText(ctx, formatModelsPlainText(catalog.models, catalog.routing));
    } else {
      emitText(ctx, formatDiagnosticsPlainText(accounts, catalog.models.length, diag, settings));
    }
  };

  pi.registerCommand("agy", {
    description: "打开 Antigravity 控制台（账号热切换、配额、模型、诊断）",
    getArgumentCompletions: (prefix: string) => {
      const candidates = [
        "accounts",
        "usage",
        "models",
        "doctor",
        "refresh",
        "credits on",
        "credits off",
        "usage --json",
      ];
      return candidates
        .filter((c) => c.startsWith(prefix.trim()))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const json = tokens.includes("--json");
      const cmd = (tokens.find((t) => !t.startsWith("-")) ?? "").toLowerCase();

      if (cmd === "refresh") {
        await runRefreshCatalog(ctx);
        return;
      }
      if (cmd === "credits") {
        const mode = (tokens[1] ?? "").toLowerCase();
        if (mode === "on" || mode === "1" || mode === "true") {
          setCreditsEnabled(true);
          emitText(ctx, "AI 积分超额兜底已开启", "info");
          return;
        }
        if (mode === "off" || mode === "0" || mode === "false") {
          setCreditsEnabled(false);
          emitText(ctx, "AI 积分超额兜底已关闭", "info");
          return;
        }
        if (!ctx.hasUI) {
          const st = getCreditsStatus();
          emitText(ctx, `AI 积分超额：${st.enabled ? "开" : "关"} (${st.detail})`);
          return;
        }
        await openOrPrint(ctx, "diagnostics", { focusCredits: true });
        return;
      }
      if (cmd === "usage") {
        await openOrPrint(ctx, "accounts", { refreshOnOpen: true, json });
        return;
      }
      if (cmd === "models") {
        await openOrPrint(ctx, "models", { json });
        return;
      }
      if (cmd === "doctor" || cmd === "diag") {
        await openOrPrint(ctx, "diagnostics", { json });
        return;
      }
      if (cmd === "accounts") {
        const sub = (tokens[1] ?? "").toLowerCase();
        const target = tokens.slice(2).join(" ");
        if (sub === "switch" && target) {
          try {
            const acc = await activateAccount(target);
            emitText(ctx, `已切换至 ${acc.email || acc.accountId}`);
          } catch (e) {
            emitText(ctx, e instanceof Error ? e.message : String(e), "error");
          }
          return;
        }
        if (sub === "remove" && target) {
          try {
            const next = await removeAccount(target);
            emitText(
              ctx,
              next ? `已解绑账号，当前激活：${next.email || next.accountId}` : "已解绑账号",
            );
          } catch (e) {
            emitText(ctx, e instanceof Error ? e.message : String(e), "error");
          }
          return;
        }
        await openOrPrint(ctx, "accounts", { json });
        return;
      }
      await openOrPrint(ctx, loadAntigravitySettings().lastTab ?? "accounts", { json });
    },
  });
}
