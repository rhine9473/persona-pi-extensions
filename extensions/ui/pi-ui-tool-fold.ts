/** Per-response tool-call folding: collapses tools in one assistant message into a translucent 1px rounded box, while Ctrl+O restores full native details. */
import { basename, isAbsolute, relative } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Presentation = Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;

type MemberStatus = "queued" | "running" | "ok" | "error" | "aborted";

interface MemberState {
  id: string;
  name: string;
  status: MemberStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  target?: string;
  shortTarget?: string;
  errorLine?: string;
  imageCount: number;
  outputPad: number;
  invalidate?: () => void;
}

interface ToolFoldSlotState {
  initialized: boolean;
  isExport: boolean;
  baseCallComponent?: Component;
  baseResultComponent?: Component;
  latestContext?: ToolRenderContext;
  latestIsPartial: boolean;
  slotComponent?: Component;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 250;
const FALLBACK_PREVIEW_LINES = 10;
const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate() {},
};

function sanitizeOneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function displayPath(value: string, cwd?: string): string {
  if (!cwd || !isAbsolute(value)) return value;
  const rel = relative(cwd, value);
  if (!rel) return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? value : rel;
}

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function clipPathTail(pathText: string, maxChars: number): string {
  if (pathText.length <= maxChars) return pathText;
  const normalized = pathText.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const tail2 = `…/${parts.slice(-2).join("/")}`;
    if (tail2.length <= maxChars) return tail2;
  }
  const base = parts.at(-1) ?? pathText;
  if (`…/${base}`.length <= maxChars) return `…/${base}`;
  return clipText(base, maxChars);
}

function extractTargets(
  name: string,
  args: unknown,
  cwd?: string,
): { target?: string; shortTarget?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const rec = args as Record<string, unknown>;
  if (typeof rec.path === "string" && rec.path.trim()) {
    const full = displayPath(rec.path.trim(), cwd);
    const short = basename(full) || full;
    return { target: clipPathTail(full, 56), shortTarget: clipText(short, 24) };
  }
  if (typeof rec.command === "string" && rec.command.trim()) {
    const cmd = sanitizeOneLine(rec.command);
    return { target: clipText(cmd, 56), shortTarget: clipText(cmd, 24) };
  }
  if (typeof rec.pattern === "string" && rec.pattern.trim()) {
    const pat = sanitizeOneLine(rec.pattern);
    return { target: clipText(pat, 40), shortTarget: clipText(pat, 20) };
  }
  if (typeof rec.query === "string" && rec.query.trim()) {
    const q = sanitizeOneLine(rec.query);
    return { target: clipText(q, 40), shortTarget: clipText(q, 20) };
  }
  if (typeof rec.url === "string" && rec.url.trim()) {
    const url = sanitizeOneLine(rec.url);
    return { target: clipText(url, 48), shortTarget: clipText(url, 24) };
  }
  if (typeof rec.name === "string" && rec.name.trim()) {
    const n = sanitizeOneLine(rec.name);
    return { target: clipText(n, 36), shortTarget: clipText(n, 20) };
  }
  if (name === "subagent_spawn" && typeof rec.prompt === "string" && rec.prompt.trim()) {
    const p = sanitizeOneLine(rec.prompt);
    return { target: clipText(p, 44), shortTarget: clipText(p, 22) };
  }
  return {};
}

function extractErrorLine(result: AgentToolResult<unknown>): string | undefined {
  const lines: string[] = [];
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      for (const raw of part.text.split(/\r?\n/)) {
        const cleaned = sanitizeOneLine(raw);
        if (cleaned) lines.push(cleaned);
      }
    }
  }
  if (lines.length === 0) return undefined;
  // Prefer an explicit error/failure line near the end instead of initial banner stdout (e.g. `> pkg test`).
  const explicit = [...lines]
    .reverse()
    .find((l) => /\b(error|failed|exception|exited with code|enoent|eperm)\b|^(?:error:|✖|×|ERR!)/i.test(l));
  return explicit ?? lines[lines.length - 1];
}

function countImages(result: AgentToolResult<unknown>): number {
  let count = 0;
  for (const part of result.content ?? []) {
    if (part.type === "image") count++;
  }
  return count;
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`;
  if (safe < 60_000) return `${Math.round(safe / 1000)}s`;
  const totalSec = Math.round(safe / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${String(secs).padStart(2, "0")}s`;
}

function groupElapsedMs(items: readonly MemberState[], now: number): number | undefined {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  let maxDur: number | undefined;
  let allHaveRange = items.length > 0;

  for (const item of items) {
    if (item.status === "queued") {
      allHaveRange = false;
      continue;
    }
    if (item.status === "running") {
      if (item.startedAt !== undefined) {
        minStart = Math.min(minStart, item.startedAt);
        maxEnd = Math.max(maxEnd, now);
      } else {
        allHaveRange = false;
      }
      continue;
    }
    if (item.durationMs !== undefined) {
      maxDur = maxDur === undefined ? item.durationMs : Math.max(maxDur, item.durationMs);
    }
    if (item.endedAt !== undefined && item.durationMs !== undefined) {
      minStart = Math.min(minStart, item.endedAt - item.durationMs);
      maxEnd = Math.max(maxEnd, item.endedAt);
    } else if (item.startedAt !== undefined && item.endedAt !== undefined) {
      minStart = Math.min(minStart, item.startedAt);
      maxEnd = Math.max(maxEnd, item.endedAt);
    } else {
      allHaveRange = false;
    }
  }

  if (allHaveRange && Number.isFinite(minStart) && Number.isFinite(maxEnd) && maxEnd >= minStart) {
    return maxEnd - minStart;
  }
  return maxDur;
}

function summarizeToolsWithTargets(items: readonly MemberState[], theme: Theme): string {
  const grouped = new Map<string, { count: number; targets: string[] }>();
  for (const item of items) {
    let entry = grouped.get(item.name);
    if (!entry) {
      entry = { count: 0, targets: [] };
      grouped.set(item.name, entry);
    }
    entry.count++;
    if (item.shortTarget && !entry.targets.includes(item.shortTarget)) {
      entry.targets.push(item.shortTarget);
    }
  }

  const sep = theme.fg("dim", " · ");
  const segments: string[] = [];
  for (const [name, info] of grouped.entries()) {
    const title = theme.fg("toolTitle", theme.bold(name));
    if (info.targets.length > 0) {
      const shown = info.targets.slice(0, 2).join(", ");
      const extra = info.count - Math.min(info.targets.length, 2);
      const extraText = extra > 0 ? theme.fg("dim", ` +${extra}`) : "";
      segments.push(`${title} ${theme.fg("text", shown)}${extraText}`);
    } else {
      segments.push(`${title}${theme.fg("muted", `×${info.count}`)}`);
    }
  }
  return segments.join(sep);
}

function padRight(text: string, targetWidth: number): string {
  const clipped = truncateToWidth(text, targetWidth, "…");
  const w = visibleWidth(clipped);
  return w >= targetWidth ? clipped : `${clipped}${" ".repeat(targetWidth - w)}`;
}

function renderSummaryBox(
  items: readonly MemberState[],
  width: number,
  theme: Theme,
  outputPad: number,
  spinnerIdx: number,
  now: number,
  keyHint?: ToolRenderContext["keyHint"],
): string[] {
  const pad = " ".repeat(Math.max(0, outputPad));
  const sep = theme.fg("dim", " · ");
  const running = items.filter((m) => m.status === "running");
  const queued = items.filter((m) => m.status === "queued");
  const errors = items.filter((m) => m.status === "error");
  const aborted = items.filter((m) => m.status === "aborted");
  const totalImages = items.reduce((sum, m) => sum + m.imageCount, 0);
  const elapsed = groupElapsedMs(items, now);
  const elapsedStr = elapsed !== undefined ? formatDuration(elapsed) : "";
  const maxBoxWidth = Math.max(24, width - outputPad * 2);

  let borderToken: "border" | "warning" | "error" | "borderMuted" = "border";
  let titleText = "";
  let rightMetaParts: string[] = [];
  const bodyLines: string[] = [];

  if (running.length > 0) {
    borderToken = "warning";
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length] ?? "⠋";
    if (running.length === 1) {
      const active = running[0]!;
      titleText = `${theme.fg("warning", frame)} ${theme.fg("toolTitle", theme.bold(active.name))}`;
      if (active.target) bodyLines.push(` ${theme.fg("text", active.target)}`);
    } else {
      titleText = `${theme.fg("warning", frame)} ${theme.fg("toolTitle", theme.bold(`${running.length} running`))}`;
      bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
    if (items.length > 1) {
      const doneCount = items.length - running.length - queued.length;
      rightMetaParts.push(`${doneCount}/${items.length}`);
      if (running.length === 1) bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
    if (elapsedStr) rightMetaParts.push(elapsedStr);
  } else if (queued.length === items.length) {
    borderToken = "borderMuted";
    if (items.length === 1) {
      const only = items[0]!;
      titleText = `${theme.fg("dim", "◌")} ${theme.fg("toolTitle", theme.bold(only.name))}`;
      if (only.target) bodyLines.push(` ${theme.fg("text", only.target)}`);
    } else {
      titleText = `${theme.fg("dim", "◌")} ${theme.fg("muted", `${items.length} calls`)}`;
      bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
  } else if (errors.length > 0) {
    borderToken = "error";
    const firstErr = errors[0]!;
    if (items.length === 1) {
      titleText = `${theme.fg("error", "✕")} ${theme.fg("error", theme.bold(firstErr.name))}`;
      if (firstErr.target) bodyLines.push(` ${theme.fg("text", firstErr.target)}`);
    } else {
      titleText = `${theme.fg("error", "✕")} ${theme.fg("text", `${items.length} calls`)} ${theme.fg("error", `· ${errors.length} failed`)}`;
      bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
    const errMsg = firstErr.errorLine ? `${firstErr.name}: ${firstErr.errorLine}` : `${firstErr.name} failed`;
    const expandHint = keyHint ? keyHint("app.tools.expand", "展开") : "";
    bodyLines.push(
      ` ${theme.fg("error", clipText(errMsg, 72))}${expandHint ? `${sep}${expandHint}` : ""}`,
    );
    if (totalImages > 0) rightMetaParts.push(`${totalImages} image${totalImages > 1 ? "s" : ""}`);
    if (elapsedStr) rightMetaParts.push(elapsedStr);
  } else if (aborted.length > 0) {
    borderToken = "borderMuted";
    if (items.length === 1) {
      const only = items[0]!;
      titleText = `${theme.fg("muted", "■")} ${theme.fg("toolTitle", theme.bold(only.name))}`;
      if (only.target) bodyLines.push(` ${theme.fg("text", only.target)}`);
    } else {
      titleText = `${theme.fg("muted", "■")} ${theme.fg("text", `${items.length} calls`)}`;
      bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
    rightMetaParts.push("aborted");
    if (elapsedStr) rightMetaParts.push(elapsedStr);
  } else {
    borderToken = "border";
    if (items.length === 1) {
      const only = items[0]!;
      titleText = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(only.name))}`;
      if (only.target) bodyLines.push(` ${theme.fg("text", only.target)}`);
    } else {
      titleText = `${theme.fg("success", "✓")} ${theme.fg("text", `${items.length} calls`)}`;
      bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
    if (totalImages > 0) rightMetaParts.push(`${totalImages} image${totalImages > 1 ? "s" : ""}`);
    if (elapsedStr) rightMetaParts.push(elapsedStr);
  }

  const titlePart = ` ${titleText} `;
  const metaText = rightMetaParts.join(" · ");
  const metaPart = metaText ? ` ${metaText} ` : "";
  const minTopWidth = visibleWidth(titlePart) + visibleWidth(metaPart) + 6;
  const maxContentWidth = bodyLines.reduce((max, line) => Math.max(max, visibleWidth(line) + 1), 0);
  const desiredBoxWidth = Math.max(38, minTopWidth, maxContentWidth + 2);
  const boxWidth = Math.min(maxBoxWidth, desiredBoxWidth);
  const innerWidth = Math.max(10, boxWidth - 2);

  const clippedTitle = truncateToWidth(titlePart, Math.max(6, innerWidth - visibleWidth(metaPart) - 3), "…");
  const fillCount = Math.max(1, innerWidth - visibleWidth(clippedTitle) - visibleWidth(metaPart) - 2);
  const b = (s: string) => theme.fg(borderToken, s);

  const topLine =
    `${pad}${b("╭─")}${clippedTitle}${b("─".repeat(fillCount))}` +
    (metaPart ? theme.fg("dim", metaPart) : "") +
    b("─╮");
  const side = b("│");
  const bottomLine = `${pad}${b(`╰${"─".repeat(innerWidth)}╯`)}`;

  const framedBody = bodyLines.map((line) => `${pad}${side}${padRight(line, innerWidth)}${side}`);
  return [topLine, ...framedBody, bottomLine].map((line) =>
    truncateToWidth(line, Math.max(1, width), theme.fg("dim", "…")),
  );
}

function createFallbackCallComponent(name: string, args: unknown, theme: Theme): Component {
  let argText = "";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    if (entries.length > 0) {
      argText = " " + entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    }
  } else if (args !== undefined) {
    argText = ` ${JSON.stringify(args)}`;
  }
  return new Text(`${theme.fg("toolTitle", theme.bold(name))}${theme.fg("muted", argText)}`, 0, 0);
}

function createFallbackResultComponent(
  result: AgentToolResult<unknown>,
  theme: Theme,
  expanded: boolean,
  keyHint: ToolRenderContext["keyHint"],
): Component | undefined {
  const output = (result.content ?? [])
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (!output) return undefined;
  const lines = output.split("\n");
  const visible = expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
  const remaining = lines.length - visible.length;
  let text = visible.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  }
  return new Text(text, 0, 0);
}

export default function piUiToolFoldExtension(pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | undefined;
  let enabled: boolean | undefined;
  const groups = new Map<string, string[]>();
  const toolToGroup = new Map<string, string>();
  const members = new Map<string, MemberState>();
  let spinnerIdx = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const syncTimer = () => {
    const isExpanded = Boolean(activeCtx?.ui?.getToolsExpanded?.());
    let hasActiveRunning = false;
    if (!isExpanded && enabled !== false) {
      for (const m of members.values()) {
        if (m.status === "running") {
          hasActiveRunning = true;
          break;
        }
      }
    }
    if (hasActiveRunning && !timer) {
      timer = setInterval(() => {
        spinnerIdx += 1;
        const visitedGroups = new Set<string>();
        for (const m of members.values()) {
          if (m.status !== "running") continue;
          const gid = toolToGroup.get(m.id);
          if (!gid || visitedGroups.has(gid)) continue;
          visitedGroups.add(gid);
          const leaderId = (groups.get(gid) ?? []).find((id) => members.has(id));
          if (leaderId) members.get(leaderId)?.invalidate?.();
        }
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    } else if (!hasActiveRunning && timer) {
      stopTimer();
    }
  };

  const registerGroup = (toolCallIds: string[]) => {
    if (toolCallIds.length === 0) return;
    const groupId = toolCallIds[0]!;
    groups.set(groupId, toolCallIds);
    for (const id of toolCallIds) {
      toolToGroup.set(id, groupId);
    }
  };

  const extractToolCallsFromMessage = (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const record = msg as { role?: string; content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) return;
    const ids: string[] = [];
    for (const part of record.content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall") {
        const tc = part as { id?: unknown };
        if (typeof tc.id === "string" && tc.id) {
          ids.push(tc.id);
        }
      }
    }
    if (ids.length > 0) registerGroup(ids);
  };

  const rebuildGroupsFromBranch = (ctx: ExtensionContext) => {
    groups.clear();
    toolToGroup.clear();
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (!entry || entry.type !== "message" || !entry.message) continue;
      const msg = entry.message as {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        timestamp?: number;
        durationMs?: number;
        isError?: boolean;
      };
      if (msg.role === "assistant") {
        extractToolCallsFromMessage(msg);
      } else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
        const existing = members.get(msg.toolCallId);
        if (existing) {
          existing.status = msg.isError ? "error" : "ok";
          if (typeof msg.timestamp === "number") existing.endedAt = msg.timestamp;
          if (typeof msg.durationMs === "number") existing.durationMs = msg.durationMs;
        }
      }
    }
    const touched = new Set<string>();
    for (const id of members.keys()) {
      const gid = toolToGroup.get(id);
      if (gid && !touched.has(gid)) {
        touched.add(gid);
        const leaderId = (groups.get(gid) ?? []).find((cid) => members.has(cid));
        if (leaderId) members.get(leaderId)?.invalidate?.();
      }
    }
  };

  const invalidateLeaderFor = (toolCallId: string) => {
    const gid = toolToGroup.get(toolCallId);
    if (!gid) return;
    const leaderId = (groups.get(gid) ?? []).find((id) => members.has(id));
    if (leaderId && leaderId !== toolCallId) {
      members.get(leaderId)?.invalidate?.();
    }
  };

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    enabled = ctx.mode === "tui" && ctx.hasUI;
    if (enabled) rebuildGroupsFromBranch(ctx);
    syncTimer();
  });

  pi.on("session_tree", (_event, ctx) => {
    activeCtx = ctx;
    if (enabled) rebuildGroupsFromBranch(ctx);
  });

  pi.on("message_update", (event) => {
    if (enabled === false) return;
    extractToolCallsFromMessage(event.message);
  });

  pi.on("message_end", (event) => {
    if (enabled === false) return;
    extractToolCallsFromMessage(event.message);
  });

  pi.on("agent_end", () => {
    const now = Date.now();
    const touchedLeaders = new Set<string>();
    for (const m of members.values()) {
      if (m.status === "running") {
        m.status = "aborted";
        m.endedAt ??= now;
        const gid = toolToGroup.get(m.id);
        const leaderId = gid ? (groups.get(gid) ?? []).find((id) => members.has(id)) : undefined;
        if (leaderId) touchedLeaders.add(leaderId);
      }
    }
    for (const leaderId of touchedLeaders) {
      members.get(leaderId)?.invalidate?.();
    }
    stopTimer();
  });

  pi.on("session_shutdown", () => {
    stopTimer();
    groups.clear();
    toolToGroup.clear();
    members.clear();
    activeCtx = undefined;
    enabled = undefined;
  });

  pi.registerToolRenderer((toolName, next): Presentation | undefined => {
    if (enabled === false) return next();
    const base = next();

    const getToolFoldState = (state: Record<string, unknown>): ToolFoldSlotState => {
      let slot = state.__toolFold as ToolFoldSlotState | undefined;
      if (!slot) {
        slot = { initialized: false, isExport: false, latestIsPartial: true };
        state.__toolFold = slot;
      }
      return slot;
    };

    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        const slot = getToolFoldState(context.state as Record<string, unknown>);
        if (!slot.initialized) {
          slot.initialized = true;
          // In live TUI, renderCall always starts before executionStarted; in HTML export, both are already true.
          slot.isExport = Boolean(context.executionStarted && context.argsComplete);
        }
        slot.latestContext = context;

        const baseCall = base?.renderCall
          ? base.renderCall(args, theme, {
              ...context,
              lastComponent: slot.baseCallComponent,
            })
          : createFallbackCallComponent(toolName, args, theme);
        slot.baseCallComponent = baseCall;

        if (slot.isExport) {
          return baseCall;
        }

        const existing = members.get(context.toolCallId);
        const now = Date.now();
        let status: MemberStatus = existing?.status ?? "queued";
        let startedAt = existing?.startedAt;
        if (context.executionStarted && status === "queued") {
          status = "running";
          startedAt ??= now;
        }
        const { target, shortTarget } = extractTargets(toolName, args, context.cwd);
        const member: MemberState = {
          id: context.toolCallId,
          name: toolName,
          status,
          startedAt,
          endedAt: existing?.endedAt,
          durationMs: existing?.durationMs,
          target: target ?? existing?.target,
          shortTarget: shortTarget ?? existing?.shortTarget,
          errorLine: existing?.errorLine,
          imageCount: existing?.imageCount ?? 0,
          outputPad: context.outputPad,
          invalidate: context.invalidate,
        };
        members.set(context.toolCallId, member);
        syncTimer();
        invalidateLeaderFor(context.toolCallId);

        if (!slot.slotComponent) {
          slot.slotComponent = {
            render(width) {
              const ctxNow = slot.latestContext;
              const expanded = Boolean(ctxNow?.expanded || activeCtx?.ui?.getToolsExpanded?.());
              const gid = ctxNow ? toolToGroup.get(ctxNow.toolCallId) : undefined;
              const groupIds = gid ? (groups.get(gid) ?? []).filter((id) => members.has(id)) : [];

              if (enabled === false || expanded || !gid || groupIds.length === 0) {
                if (base?.renderShell === "self") {
                  const callLines = slot.baseCallComponent?.render(width) ?? [];
                  const resLines = slot.baseResultComponent?.render(width) ?? [];
                  return [...callLines, ...resLines];
                }
                const bgFn = slot.latestIsPartial
                  ? (t: string) => theme.bg("toolPendingBg", t)
                  : ctxNow?.isError
                    ? (t: string) => theme.bg("toolErrorBg", t)
                    : (t: string) => theme.bg("toolSuccessBg", t);
                const box = new Box(ctxNow?.outputPad ?? 1, 1, bgFn);
                if (slot.baseCallComponent) box.addChild(slot.baseCallComponent);
                if (slot.baseResultComponent) box.addChild(slot.baseResultComponent);
                return box.render(width);
              }

              const leaderId = groupIds[0];
              if (ctxNow?.toolCallId !== leaderId) {
                return [];
              }

              const groupMembers = groupIds
                .map((id) => members.get(id))
                .filter((m): m is MemberState => Boolean(m));
              return renderSummaryBox(
                groupMembers,
                width,
                theme,
                ctxNow?.outputPad ?? 1,
                spinnerIdx,
                Date.now(),
                ctxNow?.keyHint,
              );
            },
            invalidate() {
              slot.baseCallComponent?.invalidate();
              slot.baseResultComponent?.invalidate();
            },
          };
        }
        return slot.slotComponent;
      },
      renderResult(result, options, theme, context) {
        const slot = getToolFoldState(context.state as Record<string, unknown>);
        slot.latestContext = context;
        slot.latestIsPartial = options.isPartial;

        const baseRes = base?.renderResult
          ? base.renderResult(result, options, theme, {
              ...context,
              lastComponent: slot.baseResultComponent,
            })
          : createFallbackResultComponent(result, theme, options.expanded, context.keyHint);
        slot.baseResultComponent = baseRes;

        if (slot.isExport) {
          return baseRes ?? EMPTY_COMPONENT;
        }

        const existing = members.get(context.toolCallId);
        const now = Date.now();
        const status: MemberStatus = context.isError
          ? "error"
          : options.isPartial
            ? "running"
            : "ok";
        const member: MemberState = {
          id: context.toolCallId,
          name: existing?.name ?? toolName,
          status,
          startedAt: existing?.startedAt ?? (options.isPartial ? now : undefined),
          endedAt: options.isPartial ? undefined : existing?.endedAt ?? now,
          durationMs: options.isPartial ? undefined : context.durationMs ?? existing?.durationMs,
          target: existing?.target,
          shortTarget: existing?.shortTarget,
          errorLine: context.isError ? extractErrorLine(result) : undefined,
          imageCount: countImages(result),
          outputPad: context.outputPad,
          invalidate: context.invalidate,
        };
        members.set(context.toolCallId, member);
        syncTimer();
        invalidateLeaderFor(context.toolCallId);

        return EMPTY_COMPONENT;
      },
    };
  });
}
