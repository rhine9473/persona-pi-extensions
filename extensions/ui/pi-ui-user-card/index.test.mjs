import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const hostRoot =
  process.env.PI_TEST_HOST ||
  (process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")
    : path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent"));
const hostRequire = createRequire(path.join(hostRoot, "package.json"));
const tuiPath = hostRequire.resolve("@earendil-works/pi-tui");
const { visibleWidth } = await import(pathToFileURL(tuiPath).href);

const themeMod = await import(
  pathToFileURL(path.join(hostRoot, "dist/modes/interactive/theme/theme.js")).href
);
const { initTheme, getMarkdownTheme } = themeMod;
const { UserMessageComponent } = await import(
  pathToFileURL(path.join(hostRoot, "dist/modes/interactive/components/user-message.js")).href
);
initTheme();

const { createJiti } = await import(
  pathToFileURL(path.join(hostRoot, "dist/core/extensions/jiti-loader.js")).href
);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-tui": tuiPath,
    "@earendil-works/pi-coding-agent": path.join(hostRoot, "dist/index.js"),
  },
});

const { default: piUiUserCardExtension, installUserCard, uninstallUserCard } = await jiti.import(
  path.join(here, "index.ts"),
);
const { transformUserMarkdown } = await jiti.import(path.join(here, "../pi-ui-input-fold/index.ts"));

const stripOscAndAnsi = (s) =>
  s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");

test("renders translucent rounded card with CJK alignment, OSC 133 zones, and zero bg fill", (t) => {
  t.after(() => uninstallUserCard());

  const shortText = "[Image #1] 这个是不是也可以优化，有点丑";
  const nativeMsg = new UserMessageComponent(shortText, getMarkdownTheme(), 1);
  const nativeOutput = nativeMsg.render(100);

  installUserCard(() => themeMod.theme);
  // Idempotent double install must be safe and clean.
  installUserCard(() => themeMod.theme);

  const longMixed =
    "发送框现在是整条深蓝色背景，在 Windows Terminal 的 acrylic 透明效果下非常突兀，和我们 rhine-pi-extensions 里 tool-fold 的半透明 1px 圆角卡片风格完全不搭。能不能改成同样的细线圆角样式？";

  for (const text of [shortText, longMixed]) {
    for (const width of [60, 100]) {
      const comp = new UserMessageComponent(text, getMarkdownTheme(), 1);
      const lines = comp.render(width);
      assert.ok(lines.length >= 3, "card must have top, body, bottom");
      assert.ok(lines[0].startsWith("\x1b]133;A\x07"), "OSC 133 A on first line");
      assert.ok(lines[lines.length - 1].startsWith("\x1b]133;B\x07\x1b]133;C\x07"), "OSC 133 B/C on last line");
      // Must not emit truecolor/256/ANSI background fills (48;... or 40-47m) inside the card.
      for (const line of lines) {
        assert.doesNotMatch(line, /\x1b\[48;/, "must not paint solid background color");
      }

      const plain = lines.map(stripOscAndAnsi);
      assert.match(plain[0], /^ ╭─ ❯ 你 ─+ \d{2}:\d{2} ─╮$/);
      assert.match(plain[plain.length - 1], /^ ╰─+╯$/);
      for (let i = 1; i < plain.length - 1; i++) {
        assert.match(plain[i], /^ │.*│$/);
      }
      for (const line of plain) {
        assert.equal(visibleWidth(line), width - 1, `expected right edge alignment at width ${width}: ${line}`);
      }
    }
  }

  // Narrow width falls back cleanly to native rendering.
  const narrow = new UserMessageComponent(shortText, getMarkdownTheme(), 1);
  assert.deepEqual(narrow.render(16), nativeMsg.render(16));

  // Uninstalling restores byte-identical native output.
  uninstallUserCard();
  const restored = new UserMessageComponent(shortText, getMarkdownTheme(), 1);
  assert.deepEqual(restored.render(100), nativeOutput);
});

test("preserves pi-ui-input-fold transformer and only activates in TUI mode", async (t) => {
  t.after(() => uninstallUserCard());

  const bigPaste = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}: detail`).join("\n");
  installUserCard(() => themeMod.theme);
  // ISO string timestamps (as passed during session restore) also render HH:MM cleanly.
  const isoComp = new UserMessageComponent("hi", getMarkdownTheme(), 1, [], undefined, "2026-11-21T13:14:00.000Z");
  assert.match(stripOscAndAnsi(isoComp.render(80)[0]), /^ ╭─ ❯ 你 ─+ \d{2}:\d{2} ─╮$/);

  const ts = new Date(2026, 10, 21, 21, 14, 0).getTime();
  const foldedComp = new UserMessageComponent(bigPaste, getMarkdownTheme(), 1, [transformUserMarkdown], undefined, ts);
  const plain = foldedComp.render(100).map(stripOscAndAnsi).join("\n");
  assert.match(plain, /^ ╭─ ❯ 你 ─+ 21:14 ─╮/m);
  assert.match(plain, /folded \d+ lines/);

  uninstallUserCard();

  // Headless / RPC mode must leave UserMessageComponent untouched.
  const listeners = new Map();
  piUiUserCardExtension({
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
  });
  for (const fn of listeners.get("session_start") ?? []) {
    await fn({}, { mode: "rpc", hasUI: false, ui: { theme: themeMod.theme } });
  }
  const rpcComp = new UserMessageComponent("hello", getMarkdownTheme(), 1);
  assert.match(stripOscAndAnsi(rpcComp.render(80)[0]), /^\s*$/);
});
