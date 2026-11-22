// Adapted from pi-agent-extensions (MIT); see THIRD_PARTY_NOTICES.md.
import { unlink } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CancellableLoader,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { hintLine, isSubagentSession } from "./support.ts";
import {
  createSessionStatsLoader,
  type SessionStatsState,
} from "./git-stats.js";
import {
  createSessionPreviewCache,
  measureSessionPreviewBytes,
  previewCacheKey,
} from "./preview-cache.js";
import {
  loadSessionPreviewData,
  readPreviewFileIdentity,
} from "./preview-loader.js";
import {
  buildPreviewError,
  buildSessionDescription,
  buildSessionLabel,
  buildSessionPreview,
  buildSessionSearchEntries,
  filterSessionEntries,
  formatRelativeTime,
  getSessionPaneLayout,
  type PreviewBlock,
  type PreviewMessageLike,
  parseLimit,
  type SessionInfoLike,
  type SessionPreview,
  selectSessionStatsWindow,
} from "./sessions.js";

const DEFAULT_VISIBLE = 12;
const SNIPPET_MAX = 60;
const PREVIEW_LOAD_DEBOUNCE_MS = 50;

const isPrintable = (data: string): boolean => {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 32 && code !== 127;
};

const sortSessions = (sessions: SessionInfoLike[]): SessionInfoLike[] =>
  [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());

const formatPlainLine = (session: SessionInfoLike): string => {
  const label = buildSessionLabel(session);
  const description = buildSessionDescription(session, SNIPPET_MAX);
  return `${label}\t${description}`;
};

const padAnsiRight = (text: string, width: number): string => {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
};

const themeText = (
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  kind:
    | "title"
    | "subtitle"
    | "rule"
    | "user"
    | "assistant"
    | "tool"
    | "error"
    | "muted"
    | "text"
    | "thinking",
  text: string,
): string => {
  if (kind === "title") return theme.fg("accent", theme.bold(text));
  if (kind === "subtitle") return theme.fg("dim", text);
  if (kind === "rule") return theme.fg("borderMuted", text);
  if (kind === "user") return theme.fg("accent", theme.bold(text));
  if (kind === "assistant") return theme.fg("border", theme.bold(text));
  if (kind === "tool") return theme.fg("muted", text);
  if (kind === "error") return theme.fg("error", text);
  if (kind === "muted") return theme.fg("muted", text);
  if (kind === "thinking")
    return theme.italic
      ? theme.italic(theme.fg("thinkingText", text))
      : theme.fg("thinkingText", text);
  return theme.fg("text", text);
};

interface PreviewRenderOptions {
  toolsExpanded: boolean;
  thinkingVisible: boolean;
}

const splitLines = (text: string): string[] =>
  text.replace(/\r\n/g, "\n").split("\n");

const compactText = (
  text: string,
  maxLines: number,
): { lines: string[]; hidden: number } => {
  const lines = splitLines(text)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return { lines, hidden: 0 };
  return { lines: lines.slice(0, maxLines), hidden: lines.length - maxLines };
};

const wrapStyled = (
  prefix: string,
  text: string,
  width: number,
  color: (line: string) => string,
): string[] => {
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  const wrapped = wrapTextWithAnsi(color(text), contentWidth);
  return wrapped.map((line) => `${prefix}${line}`);
};

const renderTextBlock = (
  label: string,
  text: string,
  width: number,
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
  },
  labelKind: "user" | "assistant" | "tool" | "muted" | "error" | "thinking",
): string[] => {
  const lines = [themeText(theme, labelKind, label)];
  for (const rawLine of splitLines(text)) {
    if (!rawLine.trim()) {
      lines.push("");
      continue;
    }
    lines.push(
      ...wrapStyled("  ", rawLine.trimEnd(), width, (line) =>
        theme.fg("text", line),
      ),
    );
  }
  return lines;
};

const isToolBlock = (block: PreviewBlock): boolean =>
  block.kind === "toolCall" ||
  block.kind === "toolResult" ||
  block.kind === "bash";

const summarizeToolRun = (blocks: PreviewBlock[]): string => {
  const names = new Set<string>();
  let outputLines = 0;
  let hasError = false;

  for (const block of blocks) {
    if (block.kind === "toolCall") names.add(block.name);
    if (block.kind === "toolResult") {
      if (block.name) names.add(block.name);
      outputLines += compactText(block.text, Number.MAX_SAFE_INTEGER).lines
        .length;
      hasError ||= !!block.isError;
    }
    if (block.kind === "bash") {
      names.add("bash");
      outputLines += compactText(block.output ?? "", Number.MAX_SAFE_INTEGER)
        .lines.length;
      hasError ||= !!block.isError;
    }
  }

  const nameList = Array.from(names).slice(0, 4).join(", ");
  const moreNames = names.size > 4 ? ` +${names.size - 4}` : "";
  const output = outputLines > 0 ? ` · ${outputLines} 行输出` : "";
  return `${hasError ? "✖" : "▸"} 工具活动 · ${blocks.length} 次${nameList ? ` · ${nameList}${moreNames}` : ""}${output}（按 t 展开）`;
};

const renderPreviewBlock = (
  block: PreviewBlock,
  width: number,
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  options: PreviewRenderOptions,
): string[] => {
  if (block.kind === "notice") {
    return wrapTextWithAnsi(themeText(theme, "muted", block.text), width);
  }

  if (block.kind === "user") {
    return renderTextBlock("◆ 用户", block.text, width, theme, "user");
  }

  if (block.kind === "assistant") {
    return renderTextBlock("● 助手", block.text, width, theme, "assistant");
  }

  if (block.kind === "thinking") {
    if (!options.thinkingVisible)
      return [themeText(theme, "thinking", "◌ 思考已折叠（按 h 展开）")];
    return renderTextBlock("◌ 思考", block.text, width, theme, "thinking");
  }

  if (block.kind === "toolCall") {
    const header = `▸ 调用工具 · ${block.name}`;
    if (!options.toolsExpanded || !block.args)
      return [themeText(theme, "tool", header)];
    return [
      themeText(theme, "tool", header),
      ...wrapStyled("  ", block.args, width, (line) => theme.fg("muted", line)),
    ];
  }

  if (block.kind === "toolResult") {
    const label = `${block.isError ? "✖" : "▸"} 工具返回${block.name ? ` · ${block.name}` : ""}`;
    const compact = compactText(block.text, options.toolsExpanded ? 200 : 4);
    const lines = [themeText(theme, block.isError ? "error" : "tool", label)];
    for (const line of compact.lines) {
      lines.push(
        ...wrapStyled("  ", line, width, (value) =>
          theme.fg(block.isError ? "error" : "muted", value),
        ),
      );
    }
    if (compact.hidden > 0)
      lines.push(
        theme.fg(
          "dim",
          `  … 已折叠 ${compact.hidden} 行输出（按 t 展开）`,
        ),
      );
    return lines;
  }

  if (block.kind === "bash") {
    const label = `${block.isError ? "✖" : "▸"} Bash`;
    const lines = [themeText(theme, block.isError ? "error" : "tool", label)];
    if (block.command)
      lines.push(
        ...wrapStyled("  ", `$ ${block.command}`, width, (line) =>
          theme.fg("accent", line),
        ),
      );
    const compact = compactText(
      block.output ?? "",
      options.toolsExpanded ? 200 : 4,
    );
    for (const line of compact.lines) {
      lines.push(
        ...wrapStyled("  ", line, width, (value) =>
          theme.fg(block.isError ? "error" : "muted", value),
        ),
      );
    }
    if (compact.hidden > 0)
      lines.push(
        theme.fg(
          "dim",
          `  … 已折叠 ${compact.hidden} 行输出（按 t 展开）`,
        ),
      );
    return lines;
  }

  if (block.kind === "summary") {
    return renderTextBlock(
      `◇ ${block.label}`,
      block.text,
      width,
      theme,
      "muted",
    );
  }

  return renderTextBlock(`◇ ${block.label}`, block.text, width, theme, "muted");
};

const formatItemLabel = (
  session: SessionInfoLike,
  width: number,
  theme: any,
  statsState: SessionStatsState | undefined,
): string => {
  const itemWidth = width - 4;

  const stats = statsState?.status === "ready" ? statsState.stats : undefined;
  let statsStr = "";
  let statsLen = 0;
  if (stats && (stats.add > 0 || stats.mod > 0 || stats.del > 0)) {
    const parts = [];
    if (stats.add > 0) parts.push(theme.fg("success", `+${stats.add}`));
    if (stats.mod > 0) parts.push(theme.fg("warning", `~${stats.mod}`));
    if (stats.del > 0) parts.push(theme.fg("error", `-${stats.del}`));
    statsStr = parts.join(" ");
    statsLen =
      (stats.add > 0 ? `${stats.add}`.length + 1 : 0) +
      (stats.mod > 0 ? `${stats.mod}`.length + 1 : 0) +
      (stats.del > 0 ? `${stats.del}`.length + 1 : 0) +
      parts.length -
      1;
  } else if (statsState?.status === "pending") {
    statsStr = theme.fg("dim", "·");
    statsLen = 1;
  }

  const timeWidth = Math.max(0, itemWidth - 5 - (statsLen > 0 ? statsLen + 3 : 1));
  const rawTimeStr = formatRelativeTime(
    session.modified,
    new Date(),
    timeWidth,
  );
  const timeSlotWidth = rawTimeStr ? Math.max(rawTimeStr.length, Math.min(15, timeWidth)) : 0;
  const timeStr = rawTimeStr.padStart(timeSlotWidth, " ");
  const title = buildSessionLabel(session);
  const reserved = 1 + timeSlotWidth + (statsLen > 0 ? statsLen + 2 : 0);
  const titleWidth = Math.max(5, itemWidth - reserved);
  const truncatedTitle = truncateToWidth(title, titleWidth, "…");

  const visibleTitleLen = visibleWidth(truncatedTitle);
  const paddingSize =
    itemWidth -
    visibleTitleLen -
    (statsLen > 0 ? statsLen : 0) -
    timeSlotWidth;

  if (statsStr) {
    const pad1 = " ".repeat(Math.max(1, paddingSize - 2));
    const pad2 = "  ";
    return `${truncatedTitle}${pad1}${statsStr}${pad2}${theme.fg("dim", timeStr)}`;
  } else {
    const padding = " ".repeat(Math.max(1, paddingSize));
    return `${truncatedTitle}${padding}${theme.fg("dim", timeStr)}`;
  }
};

const renderPreview = (
  preview: SessionPreview | undefined,
  width: number,
  height: number,
  scrollOffset: number,
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  options: PreviewRenderOptions,
  focus: "list" | "preview",
): { lines: string[]; totalLines: number; maxScroll: number } => {
  const raw: string[] = [];
  // Leave 1 space before the right scrollbar/border so CJK glyphs at the end
  // of a wrapped line are never clipped off.
  const contentWidth = Math.max(1, width - 2);

  if (!preview) {
    raw.push(themeText(theme, focus === "preview" ? "title" : "muted", "对话预览"));
    raw.push(themeText(theme, "subtitle", "正在加载会话预览…"));
  } else {
    const titleStr = "对话预览";
    raw.push(
      focus === "preview"
        ? themeText(theme, "title", titleStr)
        : themeText(theme, "muted", titleStr),
    );
    raw.push(themeText(theme, "subtitle", preview.subtitle));

    raw.push(
      focus === "preview"
        ? theme.fg("accent", "━".repeat(contentWidth))
        : theme.fg("borderMuted", "─".repeat(contentWidth)),
    );

    for (let i = 0; i < preview.blocks.length; i++) {
      const block = preview.blocks[i]!;
      if (!options.toolsExpanded && isToolBlock(block)) {
        const run: PreviewBlock[] = [];
        while (i < preview.blocks.length && isToolBlock(preview.blocks[i]!)) {
          run.push(preview.blocks[i]!);
          i++;
        }
        i--;
        if (raw.length > 3) raw.push("");
        raw.push(
          ...wrapTextWithAnsi(
            themeText(theme, "tool", summarizeToolRun(run)),
            contentWidth,
          ),
        );
        continue;
      }

      if (raw.length > 3) raw.push("");
      raw.push(...renderPreviewBlock(block, contentWidth, theme, options));
    }
  }

  const maxScroll = Math.max(0, raw.length - height);
  const boundedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

  // Render scrollbar directly on the outer right rounded border
  const visible: string[] = [];
  const thumbSize = Math.max(
    1,
    Math.min(height, Math.round((height / Math.max(1, raw.length)) * height)),
  );
  const thumbStart =
    maxScroll > 0
      ? Math.max(
          0,
          Math.min(
            height - thumbSize,
            Math.round((boundedOffset / maxScroll) * (height - thumbSize)),
          ),
        )
      : 0;

  for (let i = 0; i < height; i++) {
    const lineIndex = boundedOffset + i;
    const line = lineIndex < raw.length ? raw[lineIndex]! : "";

    let scrollChar = "";
    if (maxScroll > 0 && i >= thumbStart && i < thumbStart + thumbSize) {
      scrollChar = theme.fg(focus === "preview" ? "accent" : "dim", "┃");
    } else {
      scrollChar = theme.fg("border", "│");
    }

    visible.push(padAnsiRight(line, contentWidth) + " " + scrollChar);
  }

  return { lines: visible, totalLines: raw.length, maxScroll };
};

const loadSessionPreview = async (
  session: SessionInfoLike,
  cache: ReturnType<typeof createSessionPreviewCache>,
  signal: AbortSignal,
): Promise<SessionPreview> => {
  const initialIdentity = await readPreviewFileIdentity(session.path);
  const cached = cache.get(previewCacheKey(initialIdentity));
  if (cached) return cached;

  const data = await loadSessionPreviewData(session.path, { signal });
  const preview = buildSessionPreview(
    session,
    data.messages as PreviewMessageLike[],
    {
      totalMessages: data.totalMessages,
      truncatedBytes: data.truncatedBytes,
    },
  );
  cache.set(
    previewCacheKey(data.identity),
    preview,
    measureSessionPreviewBytes(preview),
  );
  return preview;
};

async function listSessions(
  ctx: ExtensionCommandContext,
): Promise<SessionInfoLike[] | null> {
  if (!ctx.hasUI) {
    const sessions = await SessionManager.list(ctx.cwd);
    return sortSessions(sessions);
  }

  let loadError: string | undefined;
  const sessions = await ctx.ui.custom<SessionInfoLike[] | null>(
    (tui, theme, _kb, done) => {
      const loader = new CancellableLoader(
        tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        "正在加载会话…",
      );

      let settled = false;
      const finish = (result: SessionInfoLike[] | null) => {
        if (settled) return;
        settled = true;
        done(result);
      };

      loader.onAbort = () => finish(null);

      const load = async () => {
        try {
          const results = await SessionManager.list(
            ctx.cwd,
            undefined,
            (loaded, total) => {
              if (total > 0) {
                loader.setMessage(`正在加载会话 (${loaded}/${total})…`);
              }
            },
          );
          const filtered = results.filter((s) => !isSubagentSession(s));
          finish(sortSessions(filtered));
        } catch (error) {
          loadError = error instanceof Error ? error.message : "未知错误";
          finish(null);
        }
      };

      void load();

      return {
        render: (width) => {
          const boxWidth = Math.min(72, Math.max(28, width));
          const innerWidth = Math.max(26, boxWidth - 2);
          const leftPad = width > boxWidth ? " ".repeat(Math.floor((width - boxWidth) / 2)) : "";
          const titlePart = " 会话 ";
          const fill = Math.max(1, innerWidth - visibleWidth(titlePart) - 1);
          const top =
            theme.fg("border", "╭─") +
            theme.bold(theme.fg("accent", titlePart)) +
            theme.fg("border", `${"─".repeat(fill)}╮`);
          const side = theme.fg("border", "│");
          const bottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const bodyLines = [
            ...loader.render(innerWidth),
            "",
            theme.fg("dim", " Esc 取消"),
          ];
          return [
            top,
            ...bodyLines.map((l) => `${side}${padAnsiRight(l, innerWidth)}${side}`),
            bottom,
          ].map((line) => truncateToWidth(`${leftPad}${line}`, Math.max(1, width), ""));
        },
        invalidate: () => loader.invalidate(),
        handleInput: (data) => {
          loader.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );

  if (loadError) {
    ctx.ui.notify(`加载会话失败：${loadError}`, "error");
  }

  return sessions;
}

async function showSessionPicker(
  ctx: ExtensionCommandContext,
  sessions: SessionInfoLike[],
  maxVisible: number,
): Promise<SessionInfoLike | null> {
  let sorted = sessions;
  let entries = buildSessionSearchEntries(sorted);
  const sessionByPath = new Map(
    sorted.map((session) => [session.path, session]),
  );

  return ctx.ui.custom<SessionInfoLike | null>(
    (tui, theme, kb, done) => {
      let filter = "";
      let selectList: SelectList;
      let filteredEntries = entries;
      let selectedPath = sorted[0]?.path ?? "";
      let previewScrollOffset = 0;
      let toolsExpanded = false;
      let thinkingVisible = false;
      const previewCache = createSessionPreviewCache();
      let activePreview: SessionPreview | undefined;
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      let previewController: AbortController | undefined;
      let previewSeq = 0;
      // Stats use a picker-scoped, per-query first-observation cache. Rows that
      // become visible later may observe later repository state; reopening the
      // picker refreshes every row without polling repositories while idle.
      const statsLoader = createSessionStatsLoader();
      let statsUniverseVersion = 0;
      let statsWindowSignature = "";
      let workspaceLoadSeq = 0;
      let disposed = false;
      let settled = false;

      let focus: "list" | "preview" = "list";
      let showAllWorkspaces = false;
      let showSubagents = false;
      let confirmingDeletePath: string | null = null;
      let isLoading = false;

      const cancelPreviewLoad = () => {
        previewSeq++;
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = undefined;
        previewController?.abort();
        previewController = undefined;
      };

      const disposePicker = () => {
        if (disposed) return;
        disposed = true;
        workspaceLoadSeq++;
        statsLoader.cancel();
        cancelPreviewLoad();
        previewCache.clear();
        activePreview = undefined;
      };
      const finishPicker = (result: SessionInfoLike | null) => {
        if (settled) return;
        settled = true;
        disposePicker();
        done(result);
      };
      const ensureStatsWindowLoad = (visibleCount: number) => {
        const targets = selectSessionStatsWindow(
          filteredEntries.map((entry) => entry.session),
          selectedPath,
          visibleCount,
        );
        const signature = `${statsUniverseVersion}:${targets
          .map((session) => session.path)
          .join("\0")}`;
        if (signature === statsWindowSignature) return;
        statsWindowSignature = signature;
        void statsLoader.reconcile(targets, sorted, () => {
          if (!disposed) tui.requestRender();
        });
      };

      const loadWorkspaceSessions = async (allWorkspaces: boolean) => {
        const loadSeq = ++workspaceLoadSeq;
        statsLoader.cancel();
        statsWindowSignature = "";
        cancelPreviewLoad();
        previewCache.clear();
        activePreview = undefined;
        isLoading = true;
        tui.requestRender();
        try {
          let results: SessionInfoLike[];
          if (allWorkspaces) {
            results = await SessionManager.listAll();
          } else {
            results = await SessionManager.list(ctx.cwd);
          }
          if (!showSubagents) {
            results = results.filter((s) => !isSubagentSession(s));
          }
          if (disposed || loadSeq !== workspaceLoadSeq) return;

          sorted = sortSessions(results);
          statsUniverseVersion++;
          for (const s of sorted) {
            sessionByPath.set(s.path, s);
          }
          entries = buildSessionSearchEntries(sorted);

          filteredEntries = filterSessionEntries(entries, filter);
          const matchedIndex = filteredEntries.findIndex(
            (entry) => entry.session.path === selectedPath,
          );
          if (matchedIndex >= 0) {
            // Keep selection
          } else {
            selectedPath = filteredEntries[0]?.session.path ?? "";
          }
          rebuild();
          schedulePreviewLoad();
        } catch (error) {
          if (disposed || loadSeq !== workspaceLoadSeq) return;
          ctx.ui.notify(
            `加载会话失败：${error instanceof Error ? error.message : error}`,
            "error",
          );
        } finally {
          if (!disposed && loadSeq === workspaceLoadSeq) {
            isLoading = false;
            tui.requestRender();
          }
        }
      };

      const schedulePreviewLoad = () => {
        cancelPreviewLoad();
        previewScrollOffset = 0;
        const session = sessionByPath.get(selectedPath);
        if (!session) {
          activePreview = undefined;
          return;
        }

        activePreview = {
          title: buildSessionLabel(session),
          subtitle: `${session.modified.toLocaleString()} · 正在加载预览`,
          blocks: [{ kind: "notice", text: "正在加载选中会话…" }],
        };

        const seq = previewSeq;
        previewTimer = setTimeout(() => {
          previewTimer = undefined;
          const controller = new AbortController();
          previewController = controller;
          void loadSessionPreview(session, previewCache, controller.signal)
            .then((preview) => {
              if (
                controller.signal.aborted ||
                seq !== previewSeq ||
                selectedPath !== session.path
              ) {
                return;
              }
              activePreview = preview;
              tui.requestRender();
            })
            .catch((error) => {
              if (
                controller.signal.aborted ||
                seq !== previewSeq ||
                selectedPath !== session.path
              ) {
                return;
              }
              activePreview = buildPreviewError(session, error);
              tui.requestRender();
            })
            .finally(() => {
              if (previewController === controller) {
                previewController = undefined;
              }
            });
        }, PREVIEW_LOAD_DEBOUNCE_MS);
      };

      const setSelectedPath = (path: string | undefined) => {
        if (!path || path === selectedPath) return;
        selectedPath = path;
        schedulePreviewLoad();
      };

      const buildItems = (
        current: typeof entries,
        listWidth: number,
      ): SelectItem[] =>
        current.map((entry) => {
          const isDeleting = confirmingDeletePath === entry.session.path;
          const label = formatItemLabel(
            entry.session,
            isDeleting ? Math.max(10, listWidth - 9) : listWidth,
            theme,
            statsLoader.get(entry.session),
          );
          return {
            value: entry.session.path,
            label: isDeleting
              ? theme.fg("error", theme.bold("[待删] ")) + label
              : label,
          };
        });

      const rebuild = () => {
        filteredEntries = filterSessionEntries(entries, filter);
        const matchedIndex = filteredEntries.findIndex(
          (entry) => entry.session.path === selectedPath,
        );
        if (matchedIndex >= 0) {
          // Keep selection
        } else {
          selectedPath = filteredEntries[0]?.session.path ?? "";
          schedulePreviewLoad();
        }
      };

      const renderFilter = (width: number) => {
        const prefix = " ⌕ ";
        const value = truncateToWidth(
          filter || "输入关键词筛选…",
          Math.max(0, width - visibleWidth(prefix) - 1),
        );
        const rule =
          focus === "list"
            ? theme.fg("accent", "━".repeat(Math.max(0, width)))
            : theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
        return [
          truncateToWidth(
            theme.fg(focus === "list" ? "accent" : "dim", prefix) +
              theme.fg(filter ? "text" : "dim", value),
            width,
          ),
          rule,
        ];
      };

      const renderFooterBar = (innerWidth: number, hasPreviewScroll: boolean, totalLines: number, contentHeight: number) => {
        const rightMeta = confirmingDeletePath
          ? ""
          : hasPreviewScroll
            ? theme.fg("dim", `${previewScrollOffset + 1}-${Math.min(previewScrollOffset + contentHeight, totalLines)}/${totalLines}  Esc 关闭`)
            : theme.fg("dim", "Esc 关闭");
        const leftBudget = Math.max(1, innerWidth - visibleWidth(rightMeta) - (rightMeta ? 2 : 1));
        const left = hintLine(
          theme,
          confirmingDeletePath
            ? [
                ["Enter/y", "确认删除"],
                ["Esc/n", "取消"],
              ]
            : [
                ["↑↓", "选择"],
                ["Enter", "打开"],
                ["Tab", "切焦点"],
                ["t", toolsExpanded ? "折叠工具" : "展开工具"],
                ["h", thinkingVisible ? "隐藏思考" : "展开思考"],
                ["Ctrl+T", showAllWorkspaces ? "当前工作区" : "全工作区"],
                ["Ctrl+B", showSubagents ? "隐藏子代理" : "含子代理"],
                ["Ctrl+D", "删除"],
              ],
          leftBudget,
          confirmingDeletePath ? "确认删除选中会话 (Enter/y 确认 · Esc/n 取消)" : undefined,
        );
        const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(rightMeta));
        return padAnsiRight(`${left}${" ".repeat(gap)}${rightMeta}`, innerWidth);
      };

      const renderSinglePane = (width: number): string[] => {
        const innerWidth = Math.max(20, width - 2);
        const termRows = Math.max(12, tui.terminal?.rows ?? 24);
        // top border (1) + filter (2) + footer rule (1) + footer (1) + bottom border (1) = 6
        const contentHeight = Math.max(4, termRows - 6);
        const filterRows = renderFilter(innerWidth);
        const listHeight = Math.max(1, contentHeight - filterRows.length);

        let bodyLines: string[] = [];
        if (isLoading) {
          bodyLines = [...filterRows, "", theme.fg("muted", "  正在加载会话…")];
        } else {
          const scrollRows = filteredEntries.length > listHeight ? 1 : 0;
          const effectiveVisible = Math.max(
            1,
            Math.min(listHeight - scrollRows, Math.max(filteredEntries.length, 1)),
          );
          ensureStatsWindowLoad(effectiveVisible);
          const items = buildItems(filteredEntries, innerWidth);
          selectList = new SelectList(items, effectiveVisible, {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.bold(theme.fg("accent", text)),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: () => theme.fg("muted", "  没有匹配的会话"),
          });
          const selectedIndex = filteredEntries.findIndex(
            (entry) => entry.session.path === selectedPath,
          );
          selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
          selectList.onSelect = (item) =>
            finishPicker(sessionByPath.get(item.value) ?? null);
          selectList.onCancel = () => finishPicker(null);
          selectList.onSelectionChange = (item) => setSelectedPath(item.value);
          bodyLines = [...filterRows, ...selectList.render(innerWidth)].slice(0, contentHeight);
        }
        while (bodyLines.length < contentHeight) bodyLines.push("");

        const scopeLabel = showAllWorkspaces ? "全工作区" : "当前工作区";
        const titlePart = ` 会话 `;
        const metaPart = ` ${filteredEntries.length} 个 · ${scopeLabel} `;
        const fill = Math.max(1, innerWidth - visibleWidth(titlePart) - visibleWidth(metaPart) - 2);
        const top =
          theme.fg("border", "╭─") +
          theme.bold(theme.fg("accent", titlePart)) +
          theme.fg("border", "─".repeat(fill)) +
          theme.fg("muted", metaPart) +
          theme.fg("border", "─╮");
        const side = theme.fg("border", "│");
        const footerRule = `${theme.fg("border", "├")}${theme.fg("borderMuted", "─".repeat(innerWidth))}${theme.fg("border", "┤")}`;
        const footer = `${side}${renderFooterBar(innerWidth, false, 0, contentHeight)}${side}`;
        const bottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
        return [
          top,
          ...bodyLines.map((l) => `${side}${padAnsiRight(l, innerWidth)}${side}`),
          footerRule,
          footer,
          bottom,
        ].map((line) => truncateToWidth(line, width, "", true));
      };

      const buildTopBorder = (
        listWidth: number,
        previewWidth: number,
        rightMeta: string,
      ): string => {
        const leftTitle = " 会话 ";
        const rightTitle = " 预览 ";
        const leftTitleStyled = focus === "list"
          ? theme.bold(theme.fg("accent", leftTitle))
          : theme.fg("muted", leftTitle);
        const rightTitleStyled = focus === "preview"
          ? theme.bold(theme.fg("accent", rightTitle))
          : theme.fg("muted", rightTitle);
        const leftFill = Math.max(1, listWidth - 2 - visibleWidth(leftTitle));
        const metaPart = rightMeta ? ` ${rightMeta} ` : "";
        const rightContentWidth = Math.max(1, previewWidth - 3 - visibleWidth(rightTitle) - visibleWidth(metaPart));
        return (
          theme.fg("border", "╭─") +
          leftTitleStyled +
          theme.fg("border", "─".repeat(leftFill)) +
          theme.fg("borderMuted", "─┬─") +
          theme.fg("border", "─") +
          rightTitleStyled +
          theme.fg("border", "─".repeat(rightContentWidth)) +
          (metaPart ? theme.fg("muted", metaPart) : "") +
          theme.fg("border", "─╮")
        );
      };

      const renderSplitPane = (width: number): string[] => {
        const layout = getSessionPaneLayout(width);
        const innerListWidth = Math.max(10, layout.listWidth - 1);
        const termRows = Math.max(12, tui.terminal?.rows ?? 24);
        // top border (1) + footer rule (1) + footer (1) + bottom border (1) = 4
        const contentHeight = Math.max(8, termRows - 4);
        const filterRows = renderFilter(innerListWidth);
        const listHeight = Math.max(1, contentHeight - filterRows.length);

        let leftLines: string[] = [];
        if (isLoading) {
          leftLines.push(...filterRows);
          leftLines.push("");
          leftLines.push(theme.fg("muted", "  正在加载会话…"));
        } else {
          const scrollRows = filteredEntries.length > listHeight ? 1 : 0;
          const effectiveVisible = Math.max(
            1,
            Math.min(
              listHeight - scrollRows,
              Math.max(filteredEntries.length, 1),
            ),
          );
          ensureStatsWindowLoad(effectiveVisible);
          const items = buildItems(filteredEntries, innerListWidth);
          selectList = new SelectList(items, effectiveVisible, {
            selectedPrefix: (text) =>
              theme.fg(focus === "list" ? "accent" : "muted", text),
            selectedText: (text) =>
              focus === "list"
                ? theme.bold(theme.fg("accent", text))
                : theme.bold(theme.fg("text", text)),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: () => theme.fg("muted", "  没有匹配的会话"),
          });
          const selectedIndex = filteredEntries.findIndex(
            (entry) => entry.session.path === selectedPath,
          );
          selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
          selectList.onSelect = (item) =>
            finishPicker(sessionByPath.get(item.value) ?? null);
          selectList.onCancel = () => finishPicker(null);
          selectList.onSelectionChange = (item) => setSelectedPath(item.value);

          leftLines = [
            ...filterRows,
            ...selectList.render(innerListWidth),
          ].slice(0, contentHeight);
        }

        while (leftLines.length < contentHeight) leftLines.push("");

        const renderedPreview = renderPreview(
          activePreview,
          layout.previewWidth,
          contentHeight,
          previewScrollOffset,
          theme,
          {
            toolsExpanded,
            thinkingVisible,
          },
          focus,
        );
        previewScrollOffset = Math.min(
          previewScrollOffset,
          renderedPreview.maxScroll,
        );
        const innerTotalWidth = Math.max(1, width - 2);
        const scopeLabel = showAllWorkspaces ? "全工作区" : "当前工作区";
        const topMeta = `${filteredEntries.length} 个会话 · ${scopeLabel}`;

        const leftBorder = theme.fg("border", "│");
        const dividerChar = theme.fg("borderMuted", " │ ");
        const lines = [buildTopBorder(layout.listWidth, layout.previewWidth, topMeta)];
        for (let i = 0; i < contentHeight; i++) {
          const left = padAnsiRight(leftLines[i] ?? "", innerListWidth);
          const right =
            renderedPreview.lines[i] ??
            `${" ".repeat(Math.max(0, layout.previewWidth - 1))}${theme.fg("border", "│")}`;
          lines.push(`${leftBorder}${left}${dividerChar}${right}`);
        }
        lines.push(
          `${theme.fg("border", "├")}${theme.fg("borderMuted", "─".repeat(innerListWidth))}${theme.fg("borderMuted", "─┴─")}${theme.fg("borderMuted", "─".repeat(Math.max(0, layout.previewWidth - 1)))}${theme.fg("border", "┤")}`,
        );
        lines.push(
          `${leftBorder}${renderFooterBar(innerTotalWidth, renderedPreview.maxScroll > 0, renderedPreview.totalLines, contentHeight)}${leftBorder}`,
        );
        lines.push(theme.fg("border", `╰${"─".repeat(innerTotalWidth)}╯`));
        return lines.map((line) => truncateToWidth(line, width, "", true));
      };

      rebuild();
      schedulePreviewLoad();

      return {
        render: (width) => {
          const layout = getSessionPaneLayout(width);
          if (layout.mode === "single") {
            focus = "list";
            return renderSinglePane(width);
          }
          return renderSplitPane(width);
        },
        invalidate: () => {
          cancelPreviewLoad();
          previewCache.clear();
          activePreview = undefined;
          rebuild();
          schedulePreviewLoad();
        },
        dispose: disposePicker,
        handleInput: (data) => {
          if (confirmingDeletePath !== null) {
            const targetPath = confirmingDeletePath;
            if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
              confirmingDeletePath = null;
              void (async () => {
                try {
                  await unlink(targetPath);
                  sorted = sorted.filter((s) => s.path !== targetPath);
                  entries = buildSessionSearchEntries(sorted);
                  sessionByPath.delete(targetPath);
                  rebuild();
                  schedulePreviewLoad();
                  ctx.ui.notify("已删除会话", "info");
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  ctx.ui.notify(`删除会话失败：${msg}`, "error");
                }
                tui.requestRender();
              })();
              return;
            }
            if (matchesKey(data, Key.escape) || data === "n" || data === "N") {
              confirmingDeletePath = null;
              tui.requestRender();
              return;
            }
            return;
          }

          const currentLayout = getSessionPaneLayout(
            tui.terminal?.columns ?? 80,
          );
          // A resize can arrive before the next render. Hidden panes must not
          // retain focus or take it from the visible session list.
          if (currentLayout.mode === "single") focus = "list";

          if (
            matchesKey(data, Key.ctrl("t")) ||
            data === "\u0014" ||
            matchesKey(data, Key.alt("w")) ||
            data === "\u001bw"
          ) {
            showAllWorkspaces = !showAllWorkspaces;
            void loadWorkspaceSessions(showAllWorkspaces);
            return;
          }

          if (matchesKey(data, Key.ctrl("b")) || data === "\u001bs") {
            showSubagents = !showSubagents;
            void loadWorkspaceSessions(showAllWorkspaces);
            return;
          }

          if (data === "\t") {
            if (currentLayout.mode === "split") {
              focus = focus === "list" ? "preview" : "list";
              tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, Key.left)) {
            if (focus === "preview") {
              focus = "list";
              tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, Key.right)) {
            if (currentLayout.mode === "split" && focus === "list") {
              focus = "preview";
              tui.requestRender();
            }
            return;
          }

          if (isLoading) return;

          if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
            if (filter.length > 0) {
              filter = filter.slice(0, -1);
              rebuild();
              tui.requestRender();
            }
            return;
          }

          if (currentLayout.mode === "split" && focus === "preview") {
            // t/h toggle the preview's tool/thinking visibility. They only
            // belong to the preview pane; when the list is focused they must
            // fall through to the filter (so queries containing t/h work).
            if (data === "t") {
              toolsExpanded = !toolsExpanded;
              previewScrollOffset = 0;
              tui.requestRender();
              return;
            }
            if (data === "h") {
              thinkingVisible = !thinkingVisible;
              previewScrollOffset = 0;
              tui.requestRender();
              return;
            }

            const pageSize = Math.max(4, (tui.terminal?.rows ?? 24) - 4);
            if (
              matchesKey(data, Key.pageDown) ||
              matchesKey(data, Key.ctrl("d"))
            ) {
              previewScrollOffset += pageSize;
              tui.requestRender();
              return;
            }
            if (
              matchesKey(data, Key.pageUp) ||
              matchesKey(data, Key.ctrl("u"))
            ) {
              previewScrollOffset = Math.max(0, previewScrollOffset - pageSize);
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
              previewScrollOffset++;
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
              previewScrollOffset = Math.max(0, previewScrollOffset - 1);
              tui.requestRender();
              return;
            }
            // Selection keys must work regardless of which pane has focus, so a
            // user who scrolled the preview can still press Enter to open the
            // highlighted session or Escape to cancel without tabbing back.
            selectList.handleInput(data);
            tui.requestRender();
            return;
          }

          if (focus === "list") {
            if (matchesKey(data, Key.ctrl("d")) || data === "\u0004") {
              if (!selectedPath) return;
              const currentSessionFile = ctx.sessionManager.getSessionFile?.();
              if (currentSessionFile && selectedPath === currentSessionFile) {
                ctx.ui.notify("无法删除当前正在使用的会话", "warning");
                return;
              }
              confirmingDeletePath = selectedPath;
              tui.requestRender();
              return;
            }

            if (isPrintable(data)) {
              filter += data;
              rebuild();
              tui.requestRender();
              return;
            }

            if (kb.matches(data, "tui.select.pageUp")) {
              const currentIndex = Math.max(
                0,
                filteredEntries.findIndex(
                  (entry) => entry.session.path === selectedPath,
                ),
              );
              const nextIndex = Math.max(0, currentIndex - maxVisible);
              selectList.setSelectedIndex(nextIndex);
              setSelectedPath(filteredEntries[nextIndex]?.session.path);
              tui.requestRender();
              return;
            }

            if (kb.matches(data, "tui.select.pageDown")) {
              const currentIndex = Math.max(
                0,
                filteredEntries.findIndex(
                  (entry) => entry.session.path === selectedPath,
                ),
              );
              const nextIndex = Math.min(
                filteredEntries.length - 1,
                currentIndex + maxVisible,
              );
              selectList.setSelectedIndex(nextIndex);
              setSelectedPath(filteredEntries[nextIndex]?.session.path);
              tui.requestRender();
              return;
            }

            selectList.handleInput(data);
            tui.requestRender();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        row: 0,
        col: 0,
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    },
  );
}

async function runSessionsCommand(
  args: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const limit = parseLimit(args, DEFAULT_VISIBLE);
  const sessions = await listSessions(ctx);

  if (!sessions || sessions.length === 0) {
    if (ctx.hasUI) {
      ctx.ui.notify("当前工作区暂无会话", "info");
    } else {
      console.log("当前工作区暂无会话");
    }
    return;
  }

  if (!ctx.hasUI) {
    for (const session of sessions) {
      console.log(formatPlainLine(session));
    }
    return;
  }

  const selection = await showSessionPicker(ctx, sessions, limit);
  if (!selection) return;

  const result = await ctx.switchSession(selection.path);
  if (result.cancelled) {
    ctx.ui.notify("已取消切换会话", "info");
  }
}

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "选择当前工作区的历史会话",
    handler: async (args, ctx) => {
      await runSessionsCommand(args, ctx);
    },
  });
}
