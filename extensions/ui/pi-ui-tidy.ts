/** Compact per-response tool-call folding: collapses all tools in one assistant message to a single translucent summary line, while Ctrl+O restores full native details. */
import { isAbsolute, relative } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

type Presentation = Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;

type MemberStatus = "queued" | "running" | "ok" | "error";

interface MemberState {
  id: string;
  name: string;
  status: MemberStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  target?: string;
  errorLine?: string;
  imageCount: number;
  outputPad: number;
  invalidate?: () => void;
}

interface TidySlotState {
  initialized: boolean;
  isExport: boolean;
  baseCallComponent?: Component;
  baseResultComponent?: Component;
  latestContext?: ToolRenderContext;
  latestIsPartial: boolean;
  slotComponent?: Component;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
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

function extractTarget(name: string, args: unknown, cwd?: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  if (typeof rec.path === "string" && rec.path.trim()) {
    return displayPath(rec.path.trim(), cwd);
  }
  if (typeof rec.command === "string" && rec.command.trim()) {
    return sanitizeOneLine(rec.command);
  }
  if (typeof rec.pattern === "string" && rec.pattern.trim()) {
    return sanitizeOneLine(rec.pattern);
  }
  if (typeof rec.query === "string" && rec.query.trim()) {
    return sanitizeOneLine(rec.query);
  }
  if (typeof rec.url === "string" && rec.url.trim()) {
    return sanitizeOneLine(rec.url);
  }
  if (typeof rec.name === "string" && rec.name.trim()) {
    return sanitizeOneLine(rec.name);
  }
  if (name === "subagent_spawn" && typeof rec.prompt === "string" && rec.prompt.trim()) {
    return sanitizeOneLine(rec.prompt);
  }
  return undefined;
}

function extractFirstTextLine(result: AgentToolResult<unknown>): string | undefined {
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      const line = part.text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (line) return sanitizeOneLine(line);
    }
  }
  return undefined;
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

function summarizeCounts(items: readonly MemberState[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(" · ");
}

function renderSummaryLine(
  items: readonly MemberState[],
  width: number,
  theme: Theme,
  outputPad: number,
  spinnerIdx: number,
  now: number,
): string {
  const pad = " ".repeat(Math.max(0, outputPad));
  const sep = theme.fg("dim", " · ");
  const running = items.filter((m) => m.status === "running");
  const queued = items.filter((m) => m.status === "queued");
  const errors = items.filter((m) => m.status === "error");
  const totalImages = items.reduce((sum, m) => sum + m.imageCount, 0);
  const elapsed = groupElapsedMs(items, now);
  const elapsedText = elapsed !== undefined ? theme.fg("dim", formatDuration(elapsed)) : "";

  const parts: string[] = [];
  let lead = theme.fg("dim", "▸");

  if (running.length > 0) {
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length] ?? "⠋";
    lead = theme.fg("warning", frame);
    if (running.length === 1) {
      const active = running[0]!;
      const label = theme.fg("toolTitle", active.name);
      const target = active.target ? ` ${theme.fg("muted", active.target)}` : "";
      parts.push(`${label}${target}`);
    } else {
      const names = [...new Set(running.map((r) => r.name))].slice(0, 3).join(", ");
      parts.push(`${theme.fg("toolTitle", `${running.length} running`)} ${theme.fg("muted", names)}`);
    }
    if (elapsedText) parts.push(elapsedText);
    if (items.length > 1) {
      const doneCount = items.length - running.length - queued.length;
      parts.push(theme.fg("muted", `${doneCount}/${items.length}`));
      parts.push(theme.fg("muted", summarizeCounts(items)));
    }
  } else if (queued.length === items.length) {
    lead = theme.fg("dim", "◌");
    if (items.length === 1) {
      const only = items[0]!;
      parts.push(`${theme.fg("muted", only.name)}${only.target ? ` ${theme.fg("dim", only.target)}` : ""}`);
    } else {
      parts.push(theme.fg("muted", `${items.length} calls`));
      parts.push(theme.fg("muted", summarizeCounts(items)));
    }
  } else if (errors.length > 0) {
    lead = theme.fg("error", "✕");
    const firstErr = errors[0]!;
    if (items.length === 1) {
      const target = firstErr.target ? ` ${theme.fg("muted", firstErr.target)}` : "";
      parts.push(`${theme.fg("error", firstErr.name)}${target}`);
      if (firstErr.errorLine) parts.push(theme.fg("error", firstErr.errorLine));
    } else {
      parts.push(theme.fg("muted", `${items.length} calls`));
      const errDetail = firstErr.errorLine ? `${firstErr.name}: ${firstErr.errorLine}` : firstErr.name;
      parts.push(theme.fg("error", `${errors.length} failed (${errDetail})`));
      parts.push(theme.fg("muted", summarizeCounts(items)));
    }
    if (totalImages > 0) parts.push(theme.fg("muted", `${totalImages} image${totalImages > 1 ? "s" : ""}`));
    if (elapsedText) parts.push(elapsedText);
  } else {
    if (items.length === 1) {
      const only = items[0]!;
      parts.push(`${theme.fg("muted", only.name)}${only.target ? ` ${theme.fg("dim", only.target)}` : ""}`);
    } else {
      parts.push(theme.fg("muted", `${items.length} calls`));
      parts.push(theme.fg("muted", summarizeCounts(items)));
    }
    if (totalImages > 0) parts.push(theme.fg("muted", `${totalImages} image${totalImages > 1 ? "s" : ""}`));
    if (elapsedText) parts.push(elapsedText);
  }

  const line = `${pad}${lead} ${parts.join(sep)}`;
  const maxWidth = Math.max(1, width - outputPad);
  return truncateToWidth(line, maxWidth, theme.fg("dim", "…"));
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

export default function piUiTidyExtension(pi: ExtensionAPI) {
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
      }, 1000);
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
        const tc = part as { id?: unknown; name?: unknown; arguments?: unknown };
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
        toolName?: string;
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
    for (const m of members.values()) {
      if (m.status === "running") {
        m.status = "ok";
        m.endedAt ??= now;
      }
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

    const getTidyState = (state: Record<string, unknown>): TidySlotState => {
      let slot = state.__tidy as TidySlotState | undefined;
      if (!slot) {
        slot = { initialized: false, isExport: false, latestIsPartial: true };
        state.__tidy = slot;
      }
      return slot;
    };

    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        const tidy = getTidyState(context.state as Record<string, unknown>);
        if (!tidy.initialized) {
          tidy.initialized = true;
          // In live TUI, renderCall always starts before executionStarted; in HTML export, both are already true.
          tidy.isExport = Boolean(context.executionStarted && context.argsComplete);
        }
        tidy.latestContext = context;

        const baseCall = base?.renderCall
          ? base.renderCall(args, theme, {
              ...context,
              lastComponent: tidy.baseCallComponent,
            })
          : createFallbackCallComponent(toolName, args, theme);
        tidy.baseCallComponent = baseCall;

        if (tidy.isExport) {
          return baseCall;
        }

        const existing = members.get(context.toolCallId);
        const now = Date.now();
        let status: MemberStatus = existing?.status ?? "queued";
        let startedAt = existing?.startedAt;
        if (context.executionStarted) {
          if (status === "queued") {
            status = "running";
            startedAt ??= now;
          }
        }
        const member: MemberState = {
          id: context.toolCallId,
          name: toolName,
          status,
          startedAt,
          endedAt: existing?.endedAt,
          durationMs: existing?.durationMs,
          target: extractTarget(toolName, args, context.cwd) ?? existing?.target,
          errorLine: existing?.errorLine,
          imageCount: existing?.imageCount ?? 0,
          outputPad: context.outputPad,
          invalidate: context.invalidate,
        };
        members.set(context.toolCallId, member);
        syncTimer();
        invalidateLeaderFor(context.toolCallId);

        if (!tidy.slotComponent) {
          tidy.slotComponent = {
            render(width) {
              const ctxNow = tidy.latestContext;
              const expanded = Boolean(ctxNow?.expanded || activeCtx?.ui?.getToolsExpanded?.());
              const gid = ctxNow ? toolToGroup.get(ctxNow.toolCallId) : undefined;
              const groupIds = gid ? (groups.get(gid) ?? []).filter((id) => members.has(id)) : [];

              if (enabled === false || expanded || !gid || groupIds.length === 0) {
                if (base?.renderShell === "self") {
                  const callLines = tidy.baseCallComponent?.render(width) ?? [];
                  const resLines = tidy.baseResultComponent?.render(width) ?? [];
                  return [...callLines, ...resLines];
                }
                const bgFn = tidy.latestIsPartial
                  ? (t: string) => theme.bg("toolPendingBg", t)
                  : ctxNow?.isError
                    ? (t: string) => theme.bg("toolErrorBg", t)
                    : (t: string) => theme.bg("toolSuccessBg", t);
                const box = new Box(ctxNow?.outputPad ?? 1, 1, bgFn);
                if (tidy.baseCallComponent) box.addChild(tidy.baseCallComponent);
                if (tidy.baseResultComponent) box.addChild(tidy.baseResultComponent);
                return box.render(width);
              }

              const leaderId = groupIds[0];
              if (ctxNow?.toolCallId !== leaderId) {
                return [];
              }

              const groupMembers = groupIds
                .map((id) => members.get(id))
                .filter((m): m is MemberState => Boolean(m));
              return [
                renderSummaryLine(
                  groupMembers,
                  width,
                  theme,
                  ctxNow?.outputPad ?? 1,
                  spinnerIdx,
                  Date.now(),
                ),
              ];
            },
            invalidate() {
              tidy.baseCallComponent?.invalidate();
              tidy.baseResultComponent?.invalidate();
            },
          };
        }
        return tidy.slotComponent;
      },
      renderResult(result, options, theme, context) {
        const tidy = getTidyState(context.state as Record<string, unknown>);
        tidy.latestContext = context;
        tidy.latestIsPartial = options.isPartial;

        const baseRes = base?.renderResult
          ? base.renderResult(result, options, theme, {
              ...context,
              lastComponent: tidy.baseResultComponent,
            })
          : createFallbackResultComponent(result, theme, options.expanded, context.keyHint);
        tidy.baseResultComponent = baseRes;

        if (tidy.isExport) {
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
          errorLine: context.isError ? extractFirstTextLine(result) : undefined,
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
