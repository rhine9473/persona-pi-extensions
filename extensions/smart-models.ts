/** Alt+M / /models / /m: model picker grouped by actual upstream source. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
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
const RECENT_FILE = path.join(getAgentDir(), "recent-models.json");
const MAX_RECENT = 5;
const RECENT = "__recent__";
const SOURCE_NAMES: Record<string, string> = {
  codex: "Codex", claude: "Claude", qoder: "Qoder", "qoder-cn": "Qoder CN",
  cline: "Cline", workbuddy: "WorkBuddy", "workbuddy-ai": "WorkBuddy AI",
  zcode: "ZCode", autoclaw: "AutoClaw", "autoclaw-cn": "AutoClaw 国内",
  antigravity: "Antigravity", "gemini-cli": "Gemini CLI", copilot: "Copilot",
  "opencode-zen-free": "OpenCode Zen Free", "trae-cn": "Trae CN",
  "trae-global": "Trae Global", group: "自动路由",
};

export const modelKey = (model: Pick<ChatModel, "provider" | "id">) =>
  JSON.stringify([model.provider, model.id]);

export function modelSource(model: ChatModel) {
  if (model.provider !== "magpie") {
    return { key: JSON.stringify([model.provider]), name: model.provider, transport: "直连" };
  }
  const slash = model.id.indexOf("/");
  const upstream = slash > 0 ? model.id.slice(0, slash) : "other";
  // Unknown community providers still retain their own group, not a mixed bucket.
  const suffix = model.name?.includes(" · ") ? model.name.split(" · ").at(-1) : undefined;
  const name = SOURCE_NAMES[upstream] || suffix || (upstream === "other" ? "其他来源" : upstream);
  return { key: JSON.stringify(["magpie", upstream]), name, transport: "magpie" };
}

export function displayModelName(model: ChatModel): string {
  const name = model.name || model.id;
  const suffix = model.provider === "magpie" ? name.lastIndexOf(" · ") : -1;
  return suffix > 0 ? name.slice(0, suffix) : name;
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

export function groupModels(models: ChatModel[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const model of models) {
    const source = modelSource(model);
    if (!groups.has(source.key)) groups.set(source.key, { ...source, models: [] });
    groups.get(source.key)!.models.push(model);
  }
  for (const group of groups.values()) {
    group.models.sort((a, b) => {
      const aRank = priceRank(displayModelName(a)), bRank = priceRank(displayModelName(b));
      // Infinity - Infinity is NaN, not a valid alphabetical tie-breaker.
      if (aRank !== bRank) return aRank < bRank ? -1 : 1;
      return displayModelName(a).localeCompare(displayModelName(b), "zh-CN", { numeric: true }) || a.id.localeCompare(b.id);
    });
  }
  return [...groups.values()].sort((a, b) =>
    Number(b.transport === "magpie") - Number(a.transport === "magpie") ||
    a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

function loadRecentModels(): RecentModelEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
    return Array.isArray(data) ? data.filter((entry) =>
      typeof entry?.provider === "string" && typeof entry?.modelId === "string").slice(0, MAX_RECENT) : [];
  } catch { return []; }
}

function saveRecentModel(model: ChatModel, thinkingLevel?: string) {
  try {
    const list = loadRecentModels().filter((entry) =>
      entry.provider !== model.provider || entry.modelId !== model.id);
    list.unshift({ provider: model.provider, modelId: model.id, thinkingLevel, lastUsed: Date.now() });
    fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list.slice(0, MAX_RECENT), null, 2), "utf8");
  } catch { /* A read-only history file must not prevent switching models. */ }
}

async function getPickerModels(ctx: ExtensionContext): Promise<ChatModel[] | null> {
  try {
    // Reload magpie's Pi catalog, not the unrestricted /v1/models catalog:
    // the user's per-agent visibility selections must remain authoritative.
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    const error = ctx.modelRegistry.getError();
    if (error) {
      ctx.ui.notify(`模型配置加载失败：${error}`, "error");
      return null;
    }
    // Includes credentials from models.json, environment and provider extensions.
    return ctx.modelRegistry.getAvailable();
  } catch {
    ctx.ui.notify("刷新模型列表失败，请检查模型配置后重试", "error");
    return null;
  }
}

/**
 * Reloads Pi's model catalog whenever magpie rewrites models.json, so a
 * provider added or removed in magpie appears without /reload or reopening
 * Pi. Silent by design: no notification, no model switch, no network.
 */
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
    // Atomic writes (magpie's) rename over the file, so a stat can land
    // mid-write; a failed reload is retried by the next change.
    void ctx.modelRegistry.refresh({ allowNetwork: false }).catch(() => {});
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    // Watch the directory: an atomic rename replaces the file's inode.
    watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name && String(name) !== "models.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(sync, 250);
    });
    watcher.on("error", () => {});
  } catch {
    watcher = undefined;
  }
  // A polling fallback covers filesystems where fs.watch reports nothing.
  const poll = setInterval(sync, 5000);
  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}

function matchesModel(model: ChatModel, query: string): boolean {
  const text = `${model.provider}/${model.id} ${model.name} ${modelSource(model).name}`.toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every((word) => text.includes(word));
}

async function applyModel(pi: ExtensionAPI, ctx: ExtensionContext, model: ChatModel, thinking?: string) {
  try {
    if (!(await pi.setModel(model))) {
      ctx.ui.notify(`模型不可用：${model.provider}/${model.id}，请检查凭据`, "error");
      return;
    }
    if (thinking && model.reasoning) pi.setThinkingLevel(thinking as ReturnType<ExtensionAPI["getThinkingLevel"]>);
    saveRecentModel(model, pi.getThinkingLevel());
    ctx.ui.notify(`已切换至 ${model.provider}/${model.id}`, "info");
  } catch (error) {
    ctx.ui.notify(`切换模型失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
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
    const search = new Input({ prompt: "搜索: ", placeholder: "来源 / 模型名称 / ID" });
    const maxVisible = Math.max(3, Math.min(10, (tui.terminal?.rows || 24) - 12));
    const layout = {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 50,
      truncatePrimary: ({ text, maxWidth }: { text: string; maxWidth: number }) => truncateToWidth(text, maxWidth, "…"),
    };
    const listTheme = {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", s),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: () => theme.fg("warning", "  没有匹配项"),
    };
    const selectedModel = () => view === "sources" ? undefined : byKey.get(list.getSelectedItem()?.value || "");
    const isCurrent = (model: ChatModel) => modelKey(model) === current;
    const rowForModel = (model: ChatModel): SelectItem => ({
      value: modelKey(model),
      label: `${isCurrent(model) ? "* " : ""}${displayModelName(model)}`,
      description: view === "recent"
        ? `${modelSource(model).name} · ${modelSource(model).transport}`
        : [formatContext(model.contextWindow), model.reasoning ? "推理" : ""].filter(Boolean).join(" · "),
    });

    function rebuild(preferred = "") {
      const query = search.getValue().trim();
      let items: SelectItem[];
      if (view === "sources") {
        const matchingRecent = recent.filter((model) => matchesModel(model, query));
        items = matchingRecent.length ? [{ value: RECENT, label: "最近使用", description: `${matchingRecent.length} 个模型` }] : [];
        for (const source of groups) {
          const matching = source.models.filter((model) => matchesModel(model, query));
          if (!matching.length) continue;
          const active = source.models.some(isCurrent);
          items.push({
            value: source.key,
            label: `${active ? "* " : ""}${source.name}`,
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
        // Keep a global model search when entering one matching source.
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
        const narrow = width < 60;
        // Give names the remaining width; metadata gets a small, bounded column.
        // Mutating the shared layout preserves selection and scroll on resize.
        layout.minPrimaryColumnWidth = Math.max(1, Math.min(18, width - 4));
        layout.maxPrimaryColumnWidth = Math.max(layout.minPrimaryColumnWidth, Math.min(76, width - 24));
        const border = new DynamicBorder((s) => theme.fg("accent", s)).render(width);
        const title = view === "sources" ? "选择模型来源"
          : view === "recent" ? "最近使用"
          : `${group?.name} / ${group?.transport}`;
        const active = selectedModel();
        const root = view === "sources" ? groups.find((source) => source.key === list.getSelectedItem()?.value) : undefined;
        const detail = active
          ? `${modelSource(active).name} · ${modelSource(active).transport} · ${formatContext(active.contextWindow) || "上下文未知"}${active.reasoning ? " · 支持推理" : ""}${isCurrent(active) ? " · 当前模型" : ""}`
          : root ? `${root.transport === "magpie" ? "通过 magpie" : "直接连接"} · ${root.models.length} 个模型${root.models.some(isCurrent) ? " · 当前来源" : ""}` : "选择来源后查看模型";
        const id = active ? `ID: ${active.provider}/${active.id}` : "只显示已配置凭据的模型 · * 当前";
        const lines = [
          ...border,
          ` ${theme.bold(theme.fg("accent", title))}`,
          "",
          ...search.render(width),
          "",
          ...list.render(width),
          "",
          theme.fg("muted", ` ${detail}`),
          theme.fg("dim", ` ${id}`),
          "",
          theme.fg("dim", narrow ? " ↑↓ 选择  Enter 确认  Esc 返回" :
            ` ↑↓ 选择  Enter ${view === "sources" ? "展开" : "切换"}  Esc 清空/返回  ← 返回  * 当前`),
          ...border,
        ];
        return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
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
  pi.on("model_select", (event) => {
    if (event.model?.provider && event.model?.id) saveRecentModel(event.model, pi.getThinkingLevel());
  });
  // Long-lived resources belong to the session, not the factory.
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
    // Only a valid trailing thinking level is a suffix; :free is part of an ID.
    const thinking = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(query);
    const pattern = thinking ? query.slice(0, thinking.index) : query;
    const lower = pattern.toLowerCase();
    const exact = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
    const byId = models.filter((model) => model.id.toLowerCase() === lower);
    const byName = models.filter((model) => displayModelName(model).toLowerCase() === lower);
    const candidates = exact.length ? exact : byId.length ? byId : byName.length ? byName : models.filter((model) => matchesModel(model, pattern));
    if (candidates.length === 1) await applyModel(pi, ctx, candidates[0], thinking?.[1]);
    else if (!candidates.length) ctx.ui.notify(`未找到可用模型：${pattern}`, "warning");
    else ctx.ui.notify(`匹配到 ${candidates.length} 个模型，请用完整 provider/model ID，或按 Alt+M 选择`, "warning");
  };
  pi.registerCommand("models", { description: "按来源选择模型（适配 magpie）", handler });
  pi.registerCommand("m", { description: "切换模型，例如 /m magpie/qoder/qfmodel", handler });
}
