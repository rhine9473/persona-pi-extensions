/** Per-response tool-call folding: collapses tools in one assistant message into a translucent full-width 1px rounded box, while Ctrl+O restores full native details. */
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
  resultMeta?: string;
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
const CODEMODE_SCRIPT_HEADER_RE = /^Script (?:completed|failed)\r?\nWall time ([\d.]+) seconds\r?\nOutput:\r?\n?/;
const SGR_RESET = "\x1b[0m";
const OSC8_CLOSE = "\x1b]8;;\x07";
const TOOL_BG_TOKENS = new Set(["toolPendingBg", "toolErrorBg", "toolSuccessBg"]);
const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate() {},
};

interface CodemodeCallRecord {
  id?: string;
  name: string;
  args?: string;
  status?: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
}

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
  for (let take = Math.min(parts.length, 4); take >= 2; take--) {
    const candidate = `…/${parts.slice(-take).join("/")}`;
    if (candidate.length <= maxChars) return candidate;
  }
  const base = parts.at(-1) ?? pathText;
  if (`…/${base}`.length <= maxChars) return `…/${base}`;
  return clipText(base, maxChars);
}

function summarizeCommand(command: string): string {
  const clean = sanitizeOneLine(command);
  // Strip leading `cd <dir> && ` so the actual command stays visible instead of getting truncated inside a long path.
  const stripped = clean.replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/i, "");
  return stripped || clean;
}

function summarizeCodemodeCode(code: string): { target?: string; shortTarget?: string } {
  const lines = code
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("// @options:") && !line.startsWith("//"));
  const toolNames: string[] = [];
  const toolRe = /\btools\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = toolRe.exec(code))) {
    const tool = match[1]!;
    if (!toolNames.includes(tool)) toolNames.push(tool);
  }
  const firstLine = sanitizeOneLine(lines[0] ?? "");
  if (toolNames.length > 0) {
    const listed = toolNames.slice(0, 4).join(", ") + (toolNames.length > 4 ? ` +${toolNames.length - 4}` : "");
    return {
      target: firstLine ? `${listed} · ${firstLine}` : `tools: ${listed}`,
      shortTarget: clipText(listed, 28),
    };
  }
  if (!firstLine) return {};
  return {
    target: lines.length > 1 ? `${firstLine} (${lines.length} 行脚本)` : firstLine,
    shortTarget: clipText(firstLine, 28),
  };
}

function extractCodemodeCallArgSummary(rawArgs: string | undefined): string | undefined {
  if (!rawArgs) return undefined;
  const trimmed = rawArgs.trim();
  if (!trimmed || trimmed === "{}") return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.path === "string" && parsed.path.trim()) {
        return basename(parsed.path.trim()) || parsed.path.trim();
      }
      if (typeof parsed.command === "string" && parsed.command.trim()) {
        return clipText(summarizeCommand(parsed.command), 28);
      }
      if (typeof parsed.pattern === "string" && parsed.pattern.trim()) {
        return clipText(sanitizeOneLine(parsed.pattern), 20);
      }
      if (typeof parsed.query === "string" && parsed.query.trim()) {
        return clipText(sanitizeOneLine(parsed.query), 20);
      }
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        return clipText(sanitizeOneLine(parsed.url), 24);
      }
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        return clipText(sanitizeOneLine(parsed.name), 20);
      }
    }
  } catch {
    // Truncated JSON preview (>200 chars): regex-extract common primary fields.
    const pathMatch = trimmed.match(/"path"\s*:\s*"([^"]+)"/);
    if (pathMatch?.[1]) return basename(pathMatch[1]) || pathMatch[1];
    const cmdMatch = trimmed.match(/"command"\s*:\s*"([^"]+)"/);
    if (cmdMatch?.[1]) return clipText(summarizeCommand(cmdMatch[1]), 28);
  }
  return undefined;
}

function getCodemodeCalls(result: AgentToolResult<unknown>): CodemodeCallRecord[] {
  const details = result.details as { calls?: unknown } | undefined;
  if (!details || !Array.isArray(details.calls)) return [];
  return details.calls.filter(
    (c): c is CodemodeCallRecord => Boolean(c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string"),
  );
}

function summarizeCodemodeCalls(calls: readonly CodemodeCallRecord[]): { target?: string; shortTarget?: string } {
  if (calls.length === 0) return {};
  const grouped = new Map<
    string,
    { count: number; targets: string[]; hasRunning: boolean; hasError: boolean; hasCancelled: boolean }
  >();
  for (const call of calls) {
    let entry = grouped.get(call.name);
    if (!entry) {
      entry = { count: 0, targets: [], hasRunning: false, hasError: false, hasCancelled: false };
      grouped.set(call.name, entry);
    }
    entry.count++;
    if (call.status === "running") entry.hasRunning = true;
    else if (call.status === "error") entry.hasError = true;
    else if (call.status === "cancelled") entry.hasCancelled = true;
    const arg = extractCodemodeCallArgSummary(call.args);
    if (arg && !entry.targets.includes(arg)) entry.targets.push(arg);
  }

  const fullParts: string[] = [];
  const shortParts: string[] = [];
  for (const [name, info] of grouped.entries()) {
    const badge = info.hasError ? "✕" : info.hasRunning ? "…" : info.hasCancelled ? "■" : "✓";
    if (info.targets.length > 0) {
      const shown = info.targets.slice(0, 3).join(", ");
      const extra = info.count - Math.min(info.targets.length, 3);
      fullParts.push(`${badge} ${name} ${shown}${extra > 0 ? ` +${extra}` : ""}`);
      shortParts.push(info.count > 1 ? `${name}×${info.count}` : `${name} ${info.targets[0]}`);
    } else if (info.count > 1) {
      fullParts.push(`${badge} ${name}×${info.count}`);
      shortParts.push(`${name}×${info.count}`);
    } else {
      fullParts.push(`${badge} ${name}`);
      shortParts.push(name);
    }
  }
  return {
    target: fullParts.join(" · "),
    shortTarget: clipText(shortParts.join(", "), 28),
  };
}

function extractCodemodeWallTimeMs(result: AgentToolResult<unknown>): number | undefined {
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      const match = part.text.match(CODEMODE_SCRIPT_HEADER_RE);
      if (match?.[1]) {
        const secs = Number(match[1]);
        if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
      }
    }
  }
  return undefined;
}

function extractTargets(
  name: string,
  args: unknown,
  cwd?: string,
): { target?: string; shortTarget?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const rec = args as Record<string, unknown>;
  if (name === "codemode" && typeof rec.code === "string" && rec.code.trim()) {
    return summarizeCodemodeCode(rec.code);
  }
  if (typeof rec.path === "string" && rec.path.trim()) {
    const full = displayPath(rec.path.trim(), cwd);
    const short = basename(full) || full;
    return { target: full, shortTarget: short };
  }
  if (typeof rec.command === "string" && rec.command.trim()) {
    const cmd = summarizeCommand(rec.command);
    return { target: cmd, shortTarget: clipText(cmd, 36) };
  }
  if (typeof rec.pattern === "string" && rec.pattern.trim()) {
    const pat = sanitizeOneLine(rec.pattern);
    return { target: pat, shortTarget: clipText(pat, 28) };
  }
  if (typeof rec.query === "string" && rec.query.trim()) {
    const q = sanitizeOneLine(rec.query);
    return { target: q, shortTarget: clipText(q, 28) };
  }
  if (typeof rec.url === "string" && rec.url.trim()) {
    const url = sanitizeOneLine(rec.url);
    return { target: url, shortTarget: clipText(url, 32) };
  }
  if (typeof rec.name === "string" && rec.name.trim()) {
    const n = sanitizeOneLine(rec.name);
    return { target: n, shortTarget: clipText(n, 24) };
  }
  if (name === "subagent_spawn" && typeof rec.prompt === "string" && rec.prompt.trim()) {
    const p = sanitizeOneLine(rec.prompt);
    return { target: p, shortTarget: clipText(p, 32) };
  }
  return {};
}

function extractResultMeta(name: string, result: AgentToolResult<unknown>): string | undefined {
  let lineCount = 0;
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      const text = name === "codemode" ? part.text.replace(CODEMODE_SCRIPT_HEADER_RE, "") : part.text;
      lineCount += text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    }
  }
  if (name === "codemode") {
    const callCount = getCodemodeCalls(result).length;
    if (callCount > 0 && lineCount > 0) return `${callCount} 次调用 · ${lineCount} 行`;
    if (callCount > 0) return `${callCount} 次调用`;
    if (lineCount > 0) return `${lineCount} 行`;
    return undefined;
  }
  if ((name === "read" || name === "bash" || name === "grep" || name === "find") && lineCount > 0) {
    return `${lineCount} 行`;
  }
  return undefined;
}

function extractErrorLine(name: string, result: AgentToolResult<unknown>): string | undefined {
  const lines: string[] = [];
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      const rawText = name === "codemode" ? part.text.replace(CODEMODE_SCRIPT_HEADER_RE, "") : part.text;
      for (const raw of rawText.split(/\r?\n/)) {
        const cleaned = sanitizeOneLine(raw);
        if (cleaned) lines.push(cleaned);
      }
    }
  }
  if (name === "codemode") {
    const failedCall = getCodemodeCalls(result).find((c) => c.status === "error" && c.error);
    if (failedCall && lines.length === 0) {
      return `${failedCall.name}: ${sanitizeOneLine(failedCall.error!)}`;
    }
  }
  if (lines.length === 0) return undefined;
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
      const shown = info.targets.slice(0, 4).join(", ");
      const extra = info.count - Math.min(info.targets.length, 4);
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

function stripAnsiForCheck(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isImageEscapeLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=") || /\x1bP[0-9;]*q/.test(line);
}

function createTranslucentTheme(theme: Theme): Theme {
  return Object.assign(Object.create(theme), {
    bg(color: string, text: string) {
      return TOOL_BG_TOKENS.has(color) ? text : theme.bg(color as never, text);
    },
  });
}

function trimOuterBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !isImageEscapeLine(lines[start]!) && stripAnsiForCheck(lines[start]!).trim().length === 0) {
    start++;
  }
  while (end > start && !isImageEscapeLine(lines[end - 1]!) && stripAnsiForCheck(lines[end - 1]!).trim().length === 0) {
    end--;
  }
  return lines.slice(start, end);
}

function hasUnclosedOsc8(text: string): boolean {
  const re = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let open = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    open = match[1]!.length > 0;
  }
  return open;
}

function frameContentLine(line: string, contentWidth: number, padStr: string, side: string): string {
  const fitted = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, "…") : line;
  const closeSeq = hasUnclosedOsc8(fitted) ? `${OSC8_CLOSE}${SGR_RESET}` : SGR_RESET;
  const w = visibleWidth(fitted);
  const trailing = w < contentWidth ? " ".repeat(contentWidth - w) : "";
  return `${padStr}${side} ${fitted}${closeSeq}${trailing} ${side}`;
}

function renderExpandedCard(
  toolName: string,
  member: MemberState | undefined,
  slot: ToolFoldSlotState,
  width: number,
  theme: Theme,
  outputPad: number,
  now: number,
): string[] {
  const pad = Math.max(0, outputPad);
  const padStr = " ".repeat(pad);
  const ctxNow = slot.latestContext;

  if (slot.baseCallComponent instanceof Box) {
    slot.baseCallComponent.setPaddingX(0);
  }

  const boxWidth = width - pad * 2;
  const innerWidth = boxWidth - 2;
  const contentWidth = innerWidth - 2;

  if (width < 20 || contentWidth < 8) {
    const callLines = slot.baseCallComponent?.render(Math.max(1, width - pad)) ?? [];
    const resLines = slot.baseResultComponent?.render(Math.max(1, width - pad)) ?? [];
    return [...callLines, ...resLines].map((line) =>
      isImageEscapeLine(line)
        ? line
        : truncateToWidth(`${padStr}${line}`, Math.max(1, width), ""),
    );
  }

  const status: MemberStatus =
    member?.status ?? (slot.latestIsPartial ? "running" : ctxNow?.isError ? "error" : "ok");
  let borderToken: "border" | "warning" | "error" | "borderMuted" = "border";
  let titleText = "";
  const metaParts: string[] = [];

  const durationMs =
    member?.durationMs ??
    (member?.endedAt !== undefined && member?.startedAt !== undefined
      ? Math.max(0, member.endedAt - member.startedAt)
      : status === "running" && member?.startedAt !== undefined
        ? Math.max(0, now - member.startedAt)
        : undefined);
  const elapsedStr = durationMs !== undefined ? formatDuration(durationMs) : "";

  if (status === "running") {
    borderToken = "warning";
    titleText = `${theme.fg("warning", "…")} ${theme.fg("toolTitle", theme.bold(toolName))}`;
    if (elapsedStr) metaParts.push(elapsedStr);
  } else if (status === "queued") {
    borderToken = "borderMuted";
    titleText = `${theme.fg("dim", "◌")} ${theme.fg("toolTitle", theme.bold(toolName))}`;
    metaParts.push("queued");
  } else if (status === "error") {
    borderToken = "error";
    titleText = `${theme.fg("error", "✕")} ${theme.fg("error", theme.bold(toolName))}`;
    if (member?.resultMeta) metaParts.push(member.resultMeta);
    if (member && member.imageCount > 0) {
      metaParts.push(`${member.imageCount} image${member.imageCount > 1 ? "s" : ""}`);
    }
    if (elapsedStr) metaParts.push(elapsedStr);
  } else if (status === "aborted") {
    borderToken = "borderMuted";
    titleText = `${theme.fg("muted", "■")} ${theme.fg("toolTitle", theme.bold(toolName))}`;
    metaParts.push("aborted");
    if (elapsedStr) metaParts.push(elapsedStr);
  } else {
    borderToken = "border";
    titleText = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(toolName))}`;
    if (member?.resultMeta) metaParts.push(member.resultMeta);
    if (member && member.imageCount > 0) {
      metaParts.push(`${member.imageCount} image${member.imageCount > 1 ? "s" : ""}`);
    }
    if (elapsedStr) metaParts.push(elapsedStr);
  }

  const metaText = metaParts.join(" · ");
  const metaPart = metaText ? ` ${metaText} ` : "";
  const clippedTitle = truncateToWidth(
    ` ${titleText} `,
    Math.max(4, innerWidth - visibleWidth(metaPart) - (metaPart ? 3 : 2)),
    "…",
  );
  const fillCount = Math.max(
    1,
    innerWidth - visibleWidth(clippedTitle) - visibleWidth(metaPart) - (metaPart ? 2 : 1),
  );
  const b = (s: string) => theme.fg(borderToken, s);
  const side = b("│");

  const topLine =
    `${padStr}${b("╭─")}${clippedTitle}${b("─".repeat(fillCount))}` +
    (metaPart ? `${theme.fg("dim", metaPart)}${b("─")}` : "") +
    b("╮");
  const bottomLine = `${padStr}${b(`╰${"─".repeat(innerWidth)}╯`)}`;

  const rawCallLines = slot.baseCallComponent?.render(contentWidth) ?? [];
  const rawResLines = slot.baseResultComponent?.render(contentWidth) ?? [];
  const callHasImages = rawCallLines.some(isImageEscapeLine);
  const resHasImages = rawResLines.some(isImageEscapeLine);

  const callLines = callHasImages ? [] : trimOuterBlankLines(rawCallLines);
  if (callLines.length > 1 && stripAnsiForCheck(callLines[0]!).trim() === toolName) {
    callLines.shift();
  }
  const resLines = resHasImages ? [] : trimOuterBlankLines(rawResLines);

  const framedBody: string[] = [];
  for (const line of callLines) {
    framedBody.push(frameContentLine(line, contentWidth, padStr, side));
  }
  if (callLines.length > 0 && resLines.length > 0) {
    framedBody.push(`${padStr}${side} ${theme.fg("borderMuted", "─".repeat(contentWidth))} ${side}`);
  }
  for (const line of resLines) {
    framedBody.push(frameContentLine(line, contentWidth, padStr, side));
  }
  if (framedBody.length === 0 && !callHasImages && !resHasImages) {
    if (member?.target) {
      framedBody.push(frameContentLine(theme.fg("text", member.target), contentWidth, padStr, side));
    } else {
      framedBody.push(`${padStr}${side}${" ".repeat(innerWidth)}${side}`);
    }
  }

  const cardLines = [topLine, ...framedBody, bottomLine].map((line) =>
    visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
  );
  if (callHasImages) cardLines.push(...rawCallLines);
  if (resHasImages) cardLines.push(...rawResLines);
  return cardLines;
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

  const availableWidth = width - Math.max(0, outputPad) * 2;
  if (width < 20 || availableWidth < 12) {
    const first = items[0];
    const line = first ? `${first.name}${first.shortTarget ? ` ${first.shortTarget}` : ""}` : "tools";
    return [truncateToWidth(`${pad}${line}`, Math.max(1, width), "…")];
  }
  const boxWidth = availableWidth;
  const innerWidth = Math.max(10, boxWidth - 2);
  const targetMax = Math.max(24, innerWidth - 4);
  const formatSingleTarget = (m: MemberState) =>
    m.target
      ? m.name === "read" || m.name === "write" || m.name === "edit" || m.name === "grep" || m.name === "find"
        ? clipPathTail(m.target, targetMax)
        : clipText(m.target, targetMax)
      : undefined;

  let borderToken: "border" | "warning" | "error" | "borderMuted" = "border";
  let titleText = "";
  const rightMetaParts: string[] = [];
  const bodyLines: string[] = [];

  if (running.length > 0) {
    borderToken = "warning";
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length] ?? "⠋";
    if (running.length === 1) {
      const active = running[0]!;
      titleText = `${theme.fg("warning", frame)} ${theme.fg("toolTitle", theme.bold(active.name))}`;
      const tgt = formatSingleTarget(active);
      if (tgt) bodyLines.push(` ${theme.fg("text", tgt)}`);
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
      const tgt = formatSingleTarget(only);
      if (tgt) bodyLines.push(` ${theme.fg("text", tgt)}`);
    } else {
      titleText = `${theme.fg("dim", "◌")} ${theme.fg("muted", `${items.length} calls`)}`;
      bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
  } else if (errors.length > 0) {
    borderToken = "error";
    const firstErr = errors[0]!;
    if (items.length === 1) {
      titleText = `${theme.fg("error", "✕")} ${theme.fg("error", theme.bold(firstErr.name))}`;
      const tgt = formatSingleTarget(firstErr);
      if (tgt) bodyLines.push(` ${theme.fg("text", tgt)}`);
      if (firstErr.resultMeta) rightMetaParts.push(firstErr.resultMeta);
    } else {
      titleText = `${theme.fg("error", "✕")} ${theme.fg("text", `${items.length} calls`)} ${theme.fg("error", `· ${errors.length} failed`)}`;
      bodyLines.push(` ${summarizeToolsWithTargets(items, theme)}`);
    }
    const errMsg = firstErr.errorLine ? `${firstErr.name}: ${firstErr.errorLine}` : `${firstErr.name} failed`;
    const expandHint = keyHint ? keyHint("app.tools.expand", "展开") : "";
    bodyLines.push(
      ` ${theme.fg("error", clipText(errMsg, Math.max(24, targetMax - 14)))}${expandHint ? `${sep}${expandHint}` : ""}`,
    );
    if (totalImages > 0) rightMetaParts.push(`${totalImages} image${totalImages > 1 ? "s" : ""}`);
    if (elapsedStr) rightMetaParts.push(elapsedStr);
  } else if (aborted.length > 0) {
    borderToken = "borderMuted";
    if (items.length === 1) {
      const only = items[0]!;
      titleText = `${theme.fg("muted", "■")} ${theme.fg("toolTitle", theme.bold(only.name))}`;
      const tgt = formatSingleTarget(only);
      if (tgt) bodyLines.push(` ${theme.fg("text", tgt)}`);
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
      const tgt = formatSingleTarget(only);
      if (tgt) bodyLines.push(` ${theme.fg("text", tgt)}`);
      if (only.resultMeta) rightMetaParts.push(only.resultMeta);
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

  const clippedTitle = truncateToWidth(titlePart, Math.max(6, innerWidth - visibleWidth(metaPart) - 3), "…");
  const fillCount = Math.max(1, innerWidth - visibleWidth(clippedTitle) - visibleWidth(metaPart) - 2);
  const b = (s: string) => theme.fg(borderToken, s);

  const topLine =
    `${pad}${b("╭─")}${clippedTitle}${b("─".repeat(fillCount))}` +
    (metaPart ? theme.fg("dim", metaPart) : "") +
    b("─╮");
  const side = b("│");
  const bottomLine = `${pad}${b(`╰${"─".repeat(innerWidth)}╯`)}`;

  const framedBody = bodyLines.map((line) => `${pad}${side}${padRight(line, innerWidth)}${SGR_RESET}${side}`);
  return [topLine, ...framedBody, bottomLine].map((line) =>
    visibleWidth(line) > width ? truncateToWidth(line, Math.max(1, width), "") : line,
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
  const slotsById = new Map<string, ToolFoldSlotState>();
  const toolNamesById = new Map<string, string>();
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
    slotsById.clear();
    toolNamesById.clear();
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

    const renderBaseCall = (
      args: unknown,
      theme: Theme,
      context: ToolRenderContext,
      slot: ToolFoldSlotState,
    ): Component => {
      const effectiveTheme = slot.isExport ? theme : createTranslucentTheme(theme);
      const effectiveCtx: ToolRenderContext = slot.isExport
        ? { ...context, lastComponent: slot.baseCallComponent }
        : { ...context, outputPad: 0, lastComponent: slot.baseCallComponent };
      const comp = base?.renderCall
        ? base.renderCall(args, effectiveTheme, effectiveCtx)
        : createFallbackCallComponent(toolName, args, effectiveTheme);
      if (!slot.isExport && comp instanceof Box) {
        comp.setPaddingX(0);
      }
      return comp;
    };

    const renderBaseResult = (
      result: AgentToolResult<unknown>,
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: ToolRenderContext,
      slot: ToolFoldSlotState,
    ): Component | undefined => {
      const effectiveTheme = slot.isExport ? theme : createTranslucentTheme(theme);
      const effectiveCtx: ToolRenderContext = slot.isExport
        ? { ...context, lastComponent: slot.baseResultComponent }
        : { ...context, outputPad: 0, lastComponent: slot.baseResultComponent };
      const comp = base?.renderResult
        ? base.renderResult(result, options, effectiveTheme, effectiveCtx)
        : createFallbackResultComponent(result, effectiveTheme, options.expanded, context.keyHint);
      if (!slot.isExport && comp instanceof Box) {
        comp.setPaddingX(0);
      }
      return comp;
    };

    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        const slot = getToolFoldState(context.state as Record<string, unknown>);
        if (!slot.initialized) {
          slot.initialized = true;
          slot.isExport = Boolean(context.executionStarted && context.argsComplete);
        }
        slot.latestContext = context;
        slotsById.set(context.toolCallId, slot);
        toolNamesById.set(context.toolCallId, toolName);

        const baseCall = renderBaseCall(args, theme, context, slot);
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
          resultMeta: existing?.resultMeta,
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
              const globalExpanded = Boolean(activeCtx?.ui?.getToolsExpanded?.());
              const expanded = Boolean(ctxNow?.expanded || globalExpanded);
              const gid = ctxNow ? toolToGroup.get(ctxNow.toolCallId) : undefined;
              const groupIds = gid ? (groups.get(gid) ?? []).filter((id) => members.has(id)) : [];
              const leaderId = groupIds[0];

              if (enabled === false) {
                if (base?.renderShell === "self") {
                  return [
                    ...(slot.baseCallComponent?.render(width) ?? []),
                    ...(slot.baseResultComponent?.render(width) ?? []),
                  ];
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

              if (expanded || !gid || groupIds.length === 0) {
                if (base?.renderShell === "self" && !(slot.baseCallComponent instanceof Box)) {
                  return [
                    ...(slot.baseCallComponent?.render(width) ?? []),
                    ...(slot.baseResultComponent?.render(width) ?? []),
                  ];
                }
                const now = Date.now();
                const ownId = ctxNow?.toolCallId;
                // Clicking a folded multi-tool box only flips ctx.expanded on the leader component;
                // render expanded cards for all group members together when global Ctrl+O is off.
                if (!globalExpanded && expanded && ownId && ownId === leaderId && groupIds.length > 1) {
                  const combined: string[] = [];
                  for (const id of groupIds) {
                    const mSlot = slotsById.get(id);
                    const mMember = members.get(id);
                    const mName = toolNamesById.get(id) ?? mMember?.name ?? toolName;
                    if (!mSlot) continue;
                    if (combined.length > 0) combined.push("");
                    combined.push(
                      ...renderExpandedCard(mName, mMember, mSlot, width, theme, ctxNow?.outputPad ?? 1, now),
                    );
                  }
                  if (combined.length > 0) return combined;
                }
                const member = ownId ? members.get(ownId) : undefined;
                return renderExpandedCard(
                  toolName,
                  member,
                  slot,
                  width,
                  theme,
                  ctxNow?.outputPad ?? 1,
                  now,
                );
              }

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
        if (!slot.initialized) {
          slot.initialized = true;
          slot.isExport = Boolean(context.executionStarted && context.argsComplete);
        }
        slot.latestContext = context;
        slot.latestIsPartial = options.isPartial;
        slotsById.set(context.toolCallId, slot);
        toolNamesById.set(context.toolCallId, toolName);

        const baseRes = renderBaseResult(result, options, theme, context, slot);
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
        const codemodeCalls = toolName === "codemode" ? getCodemodeCalls(result) : [];
        const codemodeSummary = codemodeCalls.length > 0 ? summarizeCodemodeCalls(codemodeCalls) : {};
        const durationMs = options.isPartial
          ? undefined
          : context.durationMs ??
            (toolName === "codemode" ? extractCodemodeWallTimeMs(result) : undefined) ??
            existing?.durationMs;
        const member: MemberState = {
          id: context.toolCallId,
          name: existing?.name ?? toolName,
          status,
          startedAt: existing?.startedAt ?? (options.isPartial ? now : undefined),
          endedAt: options.isPartial ? undefined : existing?.endedAt ?? now,
          durationMs,
          target: codemodeSummary.target ?? existing?.target,
          shortTarget: codemodeSummary.shortTarget ?? existing?.shortTarget,
          resultMeta: options.isPartial ? existing?.resultMeta : extractResultMeta(toolName, result),
          errorLine: context.isError ? extractErrorLine(toolName, result) : undefined,
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
