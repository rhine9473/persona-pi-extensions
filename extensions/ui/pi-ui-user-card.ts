/**
 * Translucent 1px rounded card for sent user messages (`UserMessageComponent`),
 * replacing Pi's solid `userMessageBg` slab so Windows Terminal acrylic blur
 * shows through cleanly while preserving Markdown transforms and OSC 133 zones.
 */

import {
  type ExtensionAPI,
  type Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const PATCH_KEY = Symbol.for("persona.pi-ui-user-card");
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface SavedDescriptors {
  renderDesc: PropertyDescriptor | undefined;
  invalidateDesc: PropertyDescriptor | undefined;
  renderWrapper: (width: number) => string[];
  invalidateWrapper: () => void;
}

interface MirrorState {
  child: unknown;
  md: Markdown;
  cachedBody?: string[];
  cachedWidth?: number;
  cachedLines?: string[];
}

interface NativeUserMessageInternals {
  text?: string;
  markdownTheme?: MarkdownTheme;
  outputPad?: number;
  timestamp?: number;
  children?: Array<{ options?: Record<string, unknown> }>;
}

function formatClock(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function padToWidth(line: string, targetWidth: number): string {
  const clipped = truncateToWidth(line, targetWidth, "…");
  const w = visibleWidth(clipped);
  return w >= targetWidth ? clipped : `${clipped}${" ".repeat(targetWidth - w)}`;
}

export function installUserCard(getTheme: () => Theme | undefined): void {
  const proto = UserMessageComponent.prototype as unknown as Record<string | symbol, unknown>;
  if (proto[PATCH_KEY]) {
    uninstallUserCard();
  }

  const renderDesc = Object.getOwnPropertyDescriptor(proto, "render");
  const invalidateDesc = Object.getOwnPropertyDescriptor(proto, "invalidate");
  const originalRender =
    typeof renderDesc?.value === "function" ? (renderDesc.value as (width: number) => string[]) : undefined;
  const originalInvalidate =
    typeof invalidateDesc?.value === "function" ? (invalidateDesc.value as () => void) : undefined;
  const protoParent = Object.getPrototypeOf(proto) as { invalidate?: () => void } | null;

  const mirrors = new WeakMap<object, MirrorState>();

  function renderWrapper(this: object, width: number): string[] {
    const fallback = () => (originalRender ? originalRender.call(this, width) : []);
    const theme = getTheme();
    if (!theme || width < 20) return fallback();

    try {
      const internals = this as NativeUserMessageInternals;
      const child = Array.isArray(internals.children) ? internals.children[0] : undefined;
      if (
        typeof internals.text !== "string" ||
        !internals.markdownTheme ||
        typeof internals.outputPad !== "number" ||
        !child ||
        !child.options
      ) {
        return fallback();
      }

      const pad = Math.max(0, internals.outputPad);
      const boxWidth = width - pad * 2;
      const inner = boxWidth - 2;
      if (inner < 12) return fallback();

      let mirror = mirrors.get(this);
      if (!mirror || mirror.child !== child) {
        const md = new Markdown(
          internals.text,
          1,
          0,
          internals.markdownTheme,
          { color: (content) => theme.fg("userMessageText", content) },
          child.options,
        );
        mirror = { child, md };
        mirrors.set(this, mirror);
      }

      const body = mirror.md.render(inner);
      if (mirror.cachedBody === body && mirror.cachedWidth === width && mirror.cachedLines) {
        return mirror.cachedLines;
      }

      const b = (s: string) => theme.fg("borderAccent", s);
      const badge = ` ${theme.fg("accent", theme.bold("❯ 你"))} `;
      const clock = formatClock(internals.timestamp);
      const meta = clock ? ` ${clock} ` : "";
      const topFill = Math.max(1, inner - 1 - visibleWidth(badge) - visibleWidth(meta) - (meta ? 1 : 0));
      const topLine = truncateToWidth(
        `${" ".repeat(pad)}${b("╭─")}${badge}${b("─".repeat(topFill))}` +
          (meta ? `${theme.fg("muted", meta)}${b("─")}` : "") +
          b("╮"),
        width,
        "",
      );
      const side = b("│");
      const contentLines = body.length > 0 ? body : [" ".repeat(inner)];
      const framedBody = contentLines.map((line) =>
        truncateToWidth(`${" ".repeat(pad)}${side}${padToWidth(line, inner)}${side}`, width, ""),
      );
      const bottomLine = truncateToWidth(`${" ".repeat(pad)}${b(`╰${"─".repeat(inner)}╯`)}`, width, "");

      const lines = [topLine, ...framedBody, bottomLine];
      lines[0] = OSC133_ZONE_START + lines[0];
      lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];

      mirror.cachedBody = body;
      mirror.cachedWidth = width;
      mirror.cachedLines = lines;
      return lines;
    } catch {
      return fallback();
    }
  }

  function invalidateWrapper(this: object): void {
    if (originalInvalidate) {
      originalInvalidate.call(this);
    } else if (typeof protoParent?.invalidate === "function") {
      protoParent.invalidate.call(this);
    }
    const mirror = mirrors.get(this);
    if (mirror) {
      mirror.md.invalidate();
      mirror.cachedBody = undefined;
      mirror.cachedLines = undefined;
    }
  }

  proto[PATCH_KEY] = {
    renderDesc,
    invalidateDesc,
    renderWrapper,
    invalidateWrapper,
  } satisfies SavedDescriptors;

  Object.defineProperty(proto, "render", {
    value: renderWrapper,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(proto, "invalidate", {
    value: invalidateWrapper,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export function uninstallUserCard(): void {
  const proto = UserMessageComponent.prototype as unknown as Record<string | symbol, unknown>;
  const saved = proto[PATCH_KEY] as SavedDescriptors | undefined;
  if (!saved) return;

  if (proto.render === saved.renderWrapper) {
    if (saved.renderDesc) Object.defineProperty(proto, "render", saved.renderDesc);
    else delete proto.render;
  }
  if (proto.invalidate === saved.invalidateWrapper) {
    if (saved.invalidateDesc) Object.defineProperty(proto, "invalidate", saved.invalidateDesc);
    else delete proto.invalidate;
  }
  delete proto[PATCH_KEY];
}

export default function piUiUserCardExtension(pi: ExtensionAPI) {
  let themeGetter: (() => Theme | undefined) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    themeGetter = () => ctx.ui.theme;
    installUserCard(() => themeGetter?.());
  });

  pi.on("session_shutdown", () => {
    themeGetter = undefined;
    uninstallUserCard();
  });
}
