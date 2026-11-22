/** Alt+M / /models / /m: model picker grouped by actual upstream source. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SelectList, truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

type ChatModel = Model<Api>;
interface RecentModelEntry {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  lastUsed: number;
}
interface SourceGroup {
  key: string;
  name: string;
  transport: string;
  models: ChatModel[];
}
const MAX_RECENT = 5;
const RECENT = "__recent__";
const recentFile = () => path.join(getAgentDir(), "recent-models.json");
const thinkingFile = () => path.join(getAgentDir(), "model-thinking-levels.json");
const SOURCE_NAMES: Record<string, string> = {
  codex: "Codex",
  "openai-codex": "OpenAI Codex",
  claude: "Claude",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  cline: "Cline",
  workbuddy: "WorkBuddy",
  "workbuddy-ai": "WorkBuddy AI",
  zcode: "ZCode",
  autoclaw: "AutoClaw",
  "autoclaw-cn": "AutoClaw 国内",
  antigravity: "Antigravity",
  "google-antigravity": "Google Antigravity",
  "google-vertex": "Google Vertex AI",
  "gemini-cli": "Gemini CLI",
  copilot: "Copilot",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  "opencode-zen-free": "OpenCode Zen Free",
  "trae-cn": "Trae CN",
  "trae-global": "Trae Global",
  xiaomi: "Xiaomi",
  group: "自动路由",
};

export const modelKey = (model: Pick<ChatModel, "provider" | "id">) =>
  JSON.stringify([model.provider, model.id]);

export function modelSource(model: ChatModel) {
  if (model.provider !== "magpie") {
    const name = SOURCE_NAMES[model.provider] || model.provider;
    return { key: JSON.stringify([model.provider]), name, transport: "直连" };
  }
  const slash = model.id.indexOf("/");
  const upstream = slash > 0 ? model.id.slice(0, slash) : "other";
  // Unknown community providers still retain their own group, not a mixed bucket.
  const suffix = model.name?.includes(" · ") ? model.name.split(" · ").at(-1) : undefined;
  const name = SOURCE_NAMES[upstream] || suffix || (upstream === "other" ? "其他来源" : upstream);
  return { key: JSON.stringify(["magpie", upstream]), name, transport: "magpie" };
}

export function displayModelName(model: ChatModel): string {
  const raw = model.name || model.id;
  const sep = model.provider === "magpie" ? raw.lastIndexOf(" · ") : -1;
  const base = sep > 0 ? raw.slice(0, sep) : raw;
  const sourceName = modelSource(model).name;
  // Strip redundant trailing source qualifier such as " (Antigravity)" inside a grouped picker.
  const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return base.replace(new RegExp(`\\s*\\(${escaped}\\)$`, "i"), "").trim();
}

export function formatContext(tokens?: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function priceRank(name: string): number {
  const badge = /\[([^\]]*)\]\s*$/.exec(name)?.[1] ?? "";
  const factor = /([0-9]+(?:\.[0-9]+)?)\s*x\b/i.exec(badge);
  return factor ? Number(factor[1]) : /free/i.test(badge) ? 0 : Infinity;
}

function familyAndVersionRank(model: ChatModel): [number, number, number] {
  const id = model.id.toLowerCase().replace(/^[^/]+\//, "");
  const verMatch = id.match(/(\d+)(?:\.(\d+))?/);
  const ver = verMatch ? Number(verMatch[1]) * 100 + Number(verMatch[2] ?? 0) : 0;
  const subRank = id.includes("hydrogen") && !id.includes("sonar")
    ? 0
    : id.includes("neon")
      ? 1
      : id.includes("carbon")
        ? 2
        : id.includes("argon")
          ? 3
          : id.includes("sonar")
            ? 5
            : 4;
  if (id.startsWith("gemini-")) return [0, -ver, subRank];
  if (id.startsWith("claude-opus")) return [1, -ver, 0];
  if (id.startsWith("claude-sonnet")) return [2, -ver, 0];
  if (id.startsWith("claude-")) return [3, -ver, 0];
  if (id.startsWith("gpt-")) return [4, -ver, 0];
  return [5, -ver, 0];
}

export function groupModels(models: ChatModel[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const model of models) {
    const source = modelSource(model);
    if (!groups.has(source.key)) groups.set(source.key, { ...source, models: [] });
    groups.get(source.key)!.models.push(model);
  }
  for (const group of groups.values()) {
    group.models.sort((a, b) => {
      const aRank = priceRank(displayModelName(a));
      const bRank = priceRank(displayModelName(b));
      if (aRank !== bRank) return aRank < bRank ? -1 : 1;
      const [famA, verA, subA] = familyAndVersionRank(a);
      const [famB, verB, subB] = familyAndVersionRank(b);
      if (famA !== famB) return famA - famB;
      if (verA !== verB) return verA - verB;
      if (subA !== subB) return subA - subB;
      return (
        displayModelName(a).localeCompare(displayModelName(b), "zh-CN", { numeric: true }) ||
        a.id.localeCompare(b.id)
      );
    });
  }
  return [...groups.values()].sort((a, b) =>
    Number(b.transport === "magpie") - Number(a.transport === "magpie") ||
    a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

function loadRecentModels(): RecentModelEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(recentFile(), "utf8"));
    return Array.isArray(data) ? data.filter((entry) =>
      typeof entry?.provider === "string" && typeof entry?.modelId === "string").slice(0, MAX_RECENT) : [];
  } catch { return []; }
}

function loadThinkingMap(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(thinkingFile(), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function loadModelThinkingLevel(model: Pick<ChatModel, "provider" | "id">): string | undefined {
  const id = `${model.provider}/${model.id}`;
  const fromMap = loadThinkingMap()[id];
  if (fromMap) return fromMap;
  return loadRecentModels().find((entry) => entry.provider === model.provider && entry.modelId === model.id)?.thinkingLevel;
}

export function saveModelThinkingLevel(model: Pick<ChatModel, "provider" | "id">, thinkingLevel?: string) {
  if (!thinkingLevel) return;
  try {
    const file = thinkingFile();
    const map = loadThinkingMap();
    const id = `${model.provider}/${model.id}`;
    if (map[id] === thinkingLevel) return;
    map[id] = thinkingLevel;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
  } catch { /* A read-only history file must not prevent switching models. */ }
}

function saveRecentModel(model: ChatModel, thinkingLevel?: string) {
  try {
    const file = recentFile();
    const list = loadRecentModels().filter((entry) =>
      entry.provider !== model.provider || entry.modelId !== model.id);
    list.unshift({ provider: model.provider, modelId: model.id, thinkingLevel, lastUsed: Date.now() });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX_RECENT), null, 2), "utf8");
  } catch { /* A read-only history file must not prevent switching models. */ }
}

async function getPickerModels(ctx: ExtensionContext): Promise<ChatModel[] | null> {
  try {
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    const error = ctx.modelRegistry.getError();
    if (error) {
      ctx.ui.notify(`模型配置加载失败：${error}`, "error");
      return null;
    }
    return ctx.modelRegistry.getAvailable();
  } catch {
    ctx.ui.notify("刷新模型列表失败，请检查模型配置后重试", "error");
    return null;
  }
}

function watchModelsFile(ctx: ExtensionContext): () => void {
  const file = path.join(getAgentDir(), "models.json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const stamp = () => {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  };
  last = stamp();
  const sync = () => {
    timer = undefined;
    const now = stamp();
    if (now === last) return;
    last = now;
    void ctx.modelRegistry.refresh({ allowNetwork: false }).catch(() => {});
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name && String(name) !== "models.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(sync, 250);
    });
    watcher.on("error", () => {});
  } catch {
    watcher = undefined;
  }
  const poll = setInterval(sync, 5000);
  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}

function matchesModel(model: ChatModel, query: string): boolean {
  const text = `${model.provider}/${model.id} ${displayModelName(model)} ${model.name} ${modelSource(model).name}`.toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every((word) => text.includes(word));
}

let applyingModelSelection = false;

export async function applyModel(pi: ExtensionAPI, ctx: ExtensionContext, model: ChatModel, thinking?: string) {
  try {
    if (ctx.model?.reasoning) {
      saveModelThinkingLevel(ctx.model, pi.getThinkingLevel());
    }
    const targetThinking = thinking ?? (model.reasoning ? loadModelThinkingLevel(model) : undefined);
    applyingModelSelection = true;
    try {
      if (!(await pi.setModel(model))) {
        ctx.ui.notify(`模型不可用：${model.provider}/${model.id}，请检查凭据`, "error");
        return;
      }
      if (targetThinking && model.reasoning) {
        pi.setThinkingLevel(targetThinking as ReturnType<ExtensionAPI["getThinkingLevel"]>);
      }
    } finally {
      applyingModelSelection = false;
    }
    const effectiveThinking = pi.getThinkingLevel();
    if (model.reasoning) saveModelThinkingLevel(model, effectiveThinking);
    saveRecentModel(model, effectiveThinking);
    const thinkingNote = model.reasoning && targetThinking ? ` · 思考 ${effectiveThinking}` : "";
    ctx.ui.notify(`已切换至 ${displayModelName(model)} (${model.provider}/${model.id})${thinkingNote}`, "info");
  } catch (error) {
    ctx.ui.notify(`切换模型失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function padRight(text: string, targetWidth: number): string {
  const clipped = truncateToWidth(text, targetWidth, "…");
  const w = visibleWidth(clipped);
  return w >= targetWidth ? clipped : `${clipped}${" ".repeat(targetWidth - w)}`;
}

async function openSmartModelPicker(pi: ExtensionAPI, ctx: ExtensionContext, models: ChatModel[]) {
  const groups = groupModels(models);
  const byKey = new Map(models.map((model) => [modelKey(model), model]));
  const recent = loadRecentModels().flatMap((entry) => {
    const model = byKey.get(modelKey({ provider: entry.provider, id: entry.modelId }));
    return model ? [model] : [];
  });
  const current = ctx.model ? modelKey(ctx.model) : "";
  const selected = await ctx.ui.custom<ChatModel | null>((tui, theme, kb, done) => {
    let view: "sources" | "models" | "recent" = "sources";
    let group: SourceGroup | undefined;
    let sourceQuery = "";
    let rootSelection = "";
    let list: SelectList;
    let visibleItems: SelectItem[] = [];
    let focused = false;
    const search = new Input({ prompt: " 搜索: ", placeholder: "来源 / 模型名称 / ID" });
    const maxVisible = Math.max(4, Math.min(12, (tui.terminal?.rows || 24) - 12));
    const layout = {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 50,
      truncatePrimary: ({ text, maxWidth }: { text: string; maxWidth: number }) => truncateToWidth(text, maxWidth, "…"),
    };
    const listTheme = {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.bold(theme.fg("accent", s)),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: () => theme.fg("warning", "  没有匹配项"),
    };
    const selectedModel = () => view === "sources" ? undefined : byKey.get(list.getSelectedItem()?.value || "");
    const isCurrent = (model: ChatModel) => modelKey(model) === current;
    const rowForModel = (model: ChatModel): SelectItem => ({
      value: modelKey(model),
      label: `${isCurrent(model) ? "✓ " : "  "}${displayModelName(model)}`,
      description: view === "recent"
        ? `${modelSource(model).name} · ${modelSource(model).transport}`
        : [formatContext(model.contextWindow), model.reasoning ? "推理" : ""].filter(Boolean).join(" · "),
    });

    function rebuild(preferred = "") {
      const query = search.getValue().trim();
      let items: SelectItem[];
      if (view === "sources") {
        const matchingRecent = recent.filter((model) => matchesModel(model, query));
        items = matchingRecent.length ? [{ value: RECENT, label: "  最近使用", description: `${matchingRecent.length} 个模型` }] : [];
        for (const source of groups) {
          const matching = source.models.filter((model) => matchesModel(model, query));
          if (!matching.length) continue;
          const active = source.models.some(isCurrent);
          items.push({
            value: source.key,
            label: `${active ? "✓ " : "  "}${source.name}`,
            description: `${source.transport} · ${matching.length} 个模型`,
          });
        }
      } else {
        items = (view === "recent" ? recent : group?.models || [])
          .filter((model) => matchesModel(model, query)).map(rowForModel);
      }
      visibleItems = items;
      list = new SelectList(items, maxVisible, listTheme, layout);
      const index = items.findIndex((item) => item.value === preferred);
      if (index >= 0) list.setSelectedIndex(index);
      list.onSelect = (item) => {
        if (view !== "sources") {
          const model = byKey.get(item.value);
          if (model) done(model);
          return;
        }
        sourceQuery = search.getValue();
        rootSelection = item.value;
        if (item.value === RECENT) view = "recent";
        else {
          group = groups.find((source) => source.key === item.value);
          view = "models";
        }
        search.setValue(sourceQuery);
        rebuild(current);
      };
      list.onCancel = back;
      tui.requestRender();
    }
    function back() {
      if (search.getValue()) {
        search.setValue("");
        rebuild();
      } else if (view !== "sources") {
        view = "sources";
        search.setValue(sourceQuery);
        rebuild(rootSelection);
      } else done(null);
    }
    rebuild();

    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; search.focused = value; },
      render(width: number) {
        const boxWidth = Math.min(96, Math.max(36, width));
        const innerWidth = Math.max(34, boxWidth - 2);
        const leftPad = width > boxWidth ? " ".repeat(Math.floor((width - boxWidth) / 2)) : "";
        const narrow = innerWidth < 56;
        layout.minPrimaryColumnWidth = Math.max(1, Math.min(18, innerWidth - 4));
        layout.maxPrimaryColumnWidth = Math.max(layout.minPrimaryColumnWidth, Math.min(60, innerWidth - 24));

        const title = view === "sources" ? "选择模型来源"
          : view === "recent" ? "最近使用"
          : `${group?.name} · ${group?.transport}`;
        const rightCount = view === "sources"
          ? `${groups.length} 个来源`
          : view === "recent"
            ? `${recent.length} 个模型`
            : `${group?.models.length ?? 0} 个模型`;

        const active = selectedModel();
        const root = view === "sources" ? groups.find((source) => source.key === list.getSelectedItem()?.value) : undefined;
        const rememberedThinking = active?.reasoning ? loadModelThinkingLevel(active) : undefined;
        const detail = active
          ? `${modelSource(active).name} · ${modelSource(active).transport} · ${formatContext(active.contextWindow) || "上下文未知"}${active.reasoning ? " · 支持推理" : ""}${rememberedThinking ? ` · 记忆思考: ${rememberedThinking}` : ""}${isCurrent(active) ? " · 当前模型" : ""}`
          : root ? `${root.transport === "magpie" ? "通过 Magpie" : "直连通道"} · ${root.models.length} 个模型${root.models.some(isCurrent) ? " · 当前来源" : ""}` : "选择来源后查看模型";
        const id = active ? `ID: ${active.provider}/${active.id}` : "仅显示已配置凭据的可用模型 · ✓ 当前";

        const hints = narrow
          ? "↑↓ 选择  Enter 确认  Esc 返回"
          : `↑↓ 选择  Enter ${view === "sources" ? "展开" : "切换"}  Esc 清空/返回${view !== "sources" ? "  ← 返回" : ""}`;

        const innerLines = [
          ...search.render(innerWidth),
          theme.fg("borderMuted", "─".repeat(innerWidth)),
          ...list.render(innerWidth),
          theme.fg("borderMuted", "─".repeat(innerWidth)),
          theme.fg("muted", ` ${detail}`),
          theme.fg("dim", ` ${id}`),
          theme.fg("dim", ` ${hints}`),
        ];

        const titlePart = ` ${title} `;
        const metaPart = ` ${rightCount} `;
        const fill = Math.max(1, innerWidth - visibleWidth(titlePart) - visibleWidth(metaPart) - 2);
        const top =
          theme.fg("border", "╭─") +
          theme.bold(theme.fg("accent", titlePart)) +
          theme.fg("border", "─".repeat(fill)) +
          theme.fg("muted", metaPart) +
          theme.fg("border", "─╮");
        const side = theme.fg("border", "│");
        const bottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
        const framed = [top, ...innerLines.map((l) => `${side}${padRight(l, innerWidth)}${side}`), bottom];
        return framed.map((line) => truncateToWidth(`${leftPad}${line}`, Math.max(1, width), ""));
      },
      invalidate() { search.invalidate(); list.invalidate(); },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("c"))) { done(null); return; }
        if (kb.matches(data, "tui.select.cancel")) { back(); return; }
        if (matchesKey(data, Key.left) && !search.getValue() && view !== "sources") { back(); return; }
        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          const index = visibleItems.findIndex((item) => item.value === list.getSelectedItem()?.value);
          const step = matchesKey(data, Key.pageUp) ? -maxVisible : maxVisible;
          if (index >= 0) list.setSelectedIndex(index + step);
        } else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.confirm")) {
          list.handleInput(data);
        } else {
          const previous = search.getValue();
          search.handleInput(data);
          if (previous !== search.getValue()) rebuild();
        }
        tui.requestRender();
      },
    };
  });
  if (selected) await applyModel(pi, ctx, selected);
}

export default function smartModelsExtension(pi: ExtensionAPI) {
  let stopWatching: (() => void) | undefined;
  pi.on("thinking_level_select", (event, ctx) => {
    if (!applyingModelSelection && ctx.model?.reasoning) {
      saveModelThinkingLevel(ctx.model, event.level);
    }
  });
  pi.on("model_select", (event) => {
    if (!applyingModelSelection && event.model?.provider && event.model?.id) {
      const level = pi.getThinkingLevel();
      if (event.model.reasoning && !loadModelThinkingLevel(event.model)) {
        saveModelThinkingLevel(event.model, level);
      }
      saveRecentModel(event.model, level);
    }
  });
  pi.on("session_start", (_event, ctx) => {
    stopWatching?.();
    stopWatching = watchModelsFile(ctx);
  });
  pi.on("session_shutdown", () => {
    stopWatching?.();
    stopWatching = undefined;
  });
  pi.registerShortcut(Key.alt("m"), {
    description: "按来源选择模型（适配 magpie）",
    handler: async (ctx) => {
      const models = await getPickerModels(ctx);
      if (models) await openSmartModelPicker(pi, ctx, models);
    },
  });
  const handler = async (args: string | undefined, ctx: ExtensionCommandContext) => {
    const models = await getPickerModels(ctx);
    if (!models) return;
    const query = args?.trim();
    if (!query) { await openSmartModelPicker(pi, ctx, models); return; }
    const thinking = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(query);
    const pattern = thinking ? query.slice(0, thinking.index) : query;
    const lower = pattern.toLowerCase();
    const exact = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
    const byId = models.filter((model) => model.id.toLowerCase() === lower);
    const byName = models.filter((model) => displayModelName(model).toLowerCase() === lower || model.name.toLowerCase() === lower);
    const candidates = exact.length ? exact : byId.length ? byId : byName.length ? byName : models.filter((model) => matchesModel(model, pattern));
    if (candidates.length === 1) await applyModel(pi, ctx, candidates[0], thinking?.[1]);
    else if (!candidates.length) ctx.ui.notify(`未找到可用模型：${pattern}`, "warning");
    else ctx.ui.notify(`匹配到 ${candidates.length} 个模型，请用完整 provider/model ID，或按 Alt+M 选择`, "warning");
  };
  pi.registerCommand("models", { description: "按来源选择模型（适配 magpie）", handler });
  pi.registerCommand("m", { description: "切换模型，例如 /m magpie/qoder/qfmodel", handler });
}
