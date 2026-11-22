import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { loginAntigravity, rememberAccount } from "../auth/index.js";
import type { AntigravityOAuthCredentials } from "../types/types.js";
import type { Glyphs } from "./format.js";
import { copyToClipboard, openUrlInBrowser } from "./platform.js";

export type InlineLoginState = {
  active: boolean;
  authUrl?: string;
  statusText: string;
  error?: string;
  submitting: boolean;
  input: Input;
  cancel: () => void;
  reopenBrowser: () => boolean;
  copyUrl: () => boolean;
  handleInput: (data: string) => void;
  render: (theme: Theme, g: Glyphs, spinnerFrame: string, width: number) => string[];
};

export function startInlineLogin(options: {
  onUpdate: () => void;
  onSuccess: (credentials: AntigravityOAuthCredentials) => void;
  onCancel: () => void;
  onMessage: (text: string, tone: "info" | "success" | "warning" | "error") => void;
}): InlineLoginState {
  const controller = new AbortController();
  const input = new Input({
    prompt: " › ",
    placeholder: "http://localhost:51121/oauth-callback?state=…&code=…",
  });
  let promptResolve: ((value: string) => void) | undefined;
  let settled = false;

  const state: InlineLoginState = {
    active: true,
    statusText: "正在启动本地 OAuth 回调服务…",
    submitting: false,
    input,
    cancel() {
      if (settled) {
        if (state.error) options.onCancel();
        return;
      }
      settled = true;
      state.active = false;
      controller.abort(new Error("已取消登录"));
      options.onCancel();
    },
    reopenBrowser() {
      if (!state.authUrl) return false;
      const ok = openUrlInBrowser(state.authUrl);
      options.onMessage(ok ? "已在浏览器重新打开登录页" : "无法打开浏览器，请按 y 复制链接", ok ? "info" : "warning");
      return ok;
    },
    copyUrl() {
      if (!state.authUrl) return false;
      const ok = copyToClipboard(state.authUrl);
      options.onMessage(ok ? "已复制登录链接到剪贴板" : "复制失败", ok ? "success" : "warning");
      return ok;
    },
    handleInput(data: string) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        state.cancel();
        return;
      }
      // Single-letter shortcuts work only when the manual callback box is empty.
      if (!input.getValue()) {
        if (data === "o" || data === "O") {
          state.reopenBrowser();
          return;
        }
        if (data === "y" || data === "Y") {
          state.copyUrl();
          return;
        }
      }
      input.handleInput(data);
      options.onUpdate();
    },
    render(theme: Theme, g: Glyphs, spinnerFrame: string, width: number): string[] {
      const lines: string[] = [];
      lines.push(theme.bold(theme.fg("accent", " 添加 / 重新登录 Google 账号")));
      lines.push("");

      if (state.authUrl) {
        lines.push(
          `  ${theme.fg("success", "1")}  ${theme.fg("text", "在浏览器完成 Google 授权")}          ${theme.fg("muted", "o")} ${theme.fg("dim", "重新打开")}  ${theme.fg("muted", "y")} ${theme.fg("dim", "复制链接")}`,
        );
        lines.push(`     ${theme.fg("accent", truncateToWidth(state.authUrl, Math.max(20, width - 8), "…"))}`);
      } else {
        lines.push(`  ${theme.fg("muted", "1")}  ${theme.fg("dim", state.statusText)}`);
      }

      lines.push("");
      if (state.error) {
        lines.push(`  ${theme.fg("error", g.err)}  ${theme.fg("error", truncateToWidth(`失败原因：${state.error}`, Math.max(20, width - 8), "…"))}`);
        lines.push(`     ${theme.fg("dim", "可按 Esc 返回控制台，或检查代理/网络后重试")}`);
      } else {
        lines.push(`  ${theme.fg("accent", spinnerFrame)}  ${theme.fg("text", state.submitting ? "正在换取访问令牌…" : "等待浏览器回调…")}`);
      }

      lines.push("");
      lines.push(theme.fg("dim", ` ${g.rule.repeat(2)} 远程终端或无法自动回调？请粘贴浏览器地址栏中的完整回调网址 ${g.rule.repeat(Math.max(2, width - 66))}`));
      input.focused = true;
      for (const line of input.render(Math.max(20, width - 2))) {
        lines.push(` ${line}`);
      }
      return lines;
    },
  };

  input.onEscape = () => state.cancel();
  input.onSubmit = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (promptResolve) {
      state.submitting = true;
      state.error = undefined;
      promptResolve(trimmed);
      promptResolve = undefined;
      options.onUpdate();
    }
  };

  void (async () => {
    try {
      const credentials = await loginAntigravity({
        signal: controller.signal,
        onAuth(info) {
          state.authUrl = info.url;
          state.statusText = "已在浏览器打开授权页";
          openUrlInBrowser(info.url);
          options.onUpdate();
        },
        onPrompt(prompt) {
          if (prompt.message.startsWith("Invalid callback")) {
            state.submitting = false;
            state.error = "回调链接无效，请粘贴完整 URL";
            input.setValue("");
            options.onUpdate();
          }
          return new Promise<string>((resolve) => {
            promptResolve = resolve;
          });
        },
        onProgress(message) {
          state.statusText = message;
          options.onUpdate();
        },
      });
      if (settled) return;
      settled = true;
      state.active = false;
      rememberAccount(credentials);
      options.onSuccess(credentials);
    } catch (error) {
      if (settled || controller.signal.aborted) return;
      settled = true;
      state.active = false;
      state.submitting = false;
      const msg = error instanceof Error ? error.message : String(error);
      state.error = msg;
      options.onMessage(`登录失败：${msg}`, "error");
      // Keep the inline login view open so the user can actually read the exact error before pressing Esc.
      options.onUpdate();
    }
  })();

  return state;
}
