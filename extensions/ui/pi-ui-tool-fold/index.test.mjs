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
const { Text, visibleWidth } = await import(pathToFileURL(tuiPath).href);

const { initTheme } = await import(
  pathToFileURL(path.join(hostRoot, "dist/modes/interactive/theme/theme.js")).href
);
const { createCodemodeToolDefinition } = await import(
  pathToFileURL(path.join(hostRoot, "dist/extensions/codemode/tool.js")).href
);
const { editRenderers } = await import(
  pathToFileURL(path.join(hostRoot, "dist/core/tools/renderers/edit.js")).href
);
const { ToolExecutionComponent } = await import(
  pathToFileURL(path.join(hostRoot, "dist/modes/interactive/components/tool-execution.js")).href
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
const { default: piUiToolFoldExtension } = await jiti.import(path.join(here, "index.ts"));

function createHarness({ expanded = false, mode = "tui", hasUI = true, branch = [] } = {}) {
  let toolsExpanded = expanded;
  const listeners = new Map();
  let resolver;
  const pi = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    registerToolRenderer(fn) {
      resolver = fn;
    },
  };
  piUiToolFoldExtension(pi);
  const ctx = {
    mode,
    hasUI,
    ui: {
      getToolsExpanded: () => toolsExpanded,
      setToolsExpanded: (v) => {
        toolsExpanded = v;
      },
    },
    sessionManager: {
      getBranch: () => branch,
    },
  };
  const emit = async (event, payload = {}) => {
    for (const fn of listeners.get(event) ?? []) {
      await fn(payload, ctx);
    }
  };
  const wrap = (toolName, baseDef) => resolver(toolName, () => baseDef);
  return {
    emit,
    wrap,
    setExpanded: (v) => {
      toolsExpanded = v;
    },
    ctx,
  };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const assertTranslucentCard = (rawLines, width = 100) => {
  const plain = rawLines.map(stripAnsi);
  assert.ok(rawLines.length >= 4, `expected card lines >= 4, got ${JSON.stringify(plain)}`);
  for (const line of rawLines) {
    assert.doesNotMatch(line, /\x1b\[(?:48;|4[0-7]m)/, `must not paint opaque bg: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(line) <= width, `width overflow (${visibleWidth(line)} > ${width})`);
  }
  assert.match(plain[1], /^ ╭─ .*─╮$/);
  assert.match(plain[plain.length - 1], /^ ╰─+╯$/);
  return plain;
};

test("folds 3 tools into a translucent rounded box and restores all on Ctrl+O", async () => {
  const h = createHarness();
  await h.emit("session_start", {});

  const baseDef = {
    renderCall: (args) => new Text(`CALL ${args.path ?? args.command}`, 0, 0),
    renderResult: (res) => new Text(`RES ${res.content[0]?.text ?? ""}`, 0, 0),
  };

  await h.emit("message_update", {
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: "read" },
        { type: "toolCall", id: "tc-2", name: "read" },
        { type: "toolCall", id: "tc-3", name: "bash" },
      ],
    },
  });

  const ui = { requestRender: () => {} };
  const c1 = new ToolExecutionComponent("read", "tc-1", { path: "src/a.ts" }, {}, h.wrap("read", baseDef), ui, process.cwd());
  const c2 = new ToolExecutionComponent("read", "tc-2", { path: "src/b.ts" }, {}, h.wrap("read", baseDef), ui, process.cwd());
  const c3 = new ToolExecutionComponent("bash", "tc-3", { command: "npm test" }, {}, h.wrap("bash", baseDef), ui, process.cwd());

  for (const c of [c1, c2, c3]) c.markExecutionStarted();
  c1.updateResult({ content: [{ type: "text", text: "ok1" }], durationMs: 200 }, false);
  c2.updateResult({ content: [{ type: "text", text: "ok2" }], durationMs: 300 }, false);
  c3.updateResult({ content: [{ type: "text", text: "ok3" }], durationMs: 1200 }, false);

  const l1 = c1.render(100).map(stripAnsi);
  const l2 = c2.render(100);
  const l3 = c3.render(100);

  // Leading spacer + top border + body + bottom border = 4 lines
  assert.equal(l1.length, 4, `expected rounded box, got ${JSON.stringify(l1)}`);
  assert.equal(l1[0], "");
  assert.match(l1[1], /^ ╭─ ✓ 3 calls ─+ .* ─╮$/);
  assert.match(l1[2], /^ │ read a\.ts, b\.ts · bash npm test\s+│$/);
  assert.match(l1[3], /^ ╰─+╯$/);
  assert.equal(l2.length, 0, "second tool must fold to 0 lines");
  assert.equal(l3.length, 0, "third tool must fold to 0 lines");
  for (const line of l1) assert.equal(visibleWidth(line) <= 100, true);
  assert.equal(visibleWidth(l1[1]), 99, "1 left pad + full 98-col boxWidth");

  // Ctrl+O expand -> every tool renders a translucent rounded card (no solid background fill)
  h.setExpanded(true);
  for (const c of [c1, c2, c3]) c.setExpanded(true);
  const exp1 = assertTranslucentCard(c1.render(100), 100);
  const exp2 = assertTranslucentCard(c2.render(100), 100);
  const exp3 = assertTranslucentCard(c3.render(100), 100);
  assert.match(exp1.join("\n"), /╭─ ✓ read[\s\S]*CALL src\/a\.ts[\s\S]*RES ok1/);
  assert.match(exp2.join("\n"), /╭─ ✓ read[\s\S]*CALL src\/b\.ts[\s\S]*RES ok2/);
  assert.match(exp3.join("\n"), /╭─ ✓ bash[\s\S]*CALL npm test[\s\S]*RES ok3/);

  // Ctrl+O collapse again -> returns to rounded box + 0 follower lines
  h.setExpanded(false);
  for (const c of [c1, c2, c3]) c.setExpanded(false);
  assert.equal(c1.render(100).length, 4);
  assert.equal(c2.render(100).length, 0);
  assert.equal(c3.render(100).length, 0);

  // Clicking only leader (without global Ctrl+O) expands all group members inside leader
  c1.setExpanded(true);
  const clicked = c1.render(100);
  for (const line of clicked) assert.doesNotMatch(line, /\x1b\[(?:48;|4[0-7]m)/);
  const clickedPlain = clicked.map(stripAnsi).join("\n");
  assert.match(clickedPlain, /CALL src\/a\.ts/);
  assert.match(clickedPlain, /CALL src\/b\.ts/);
  assert.match(clickedPlain, /CALL npm test/);
  c1.setExpanded(false);

  await h.emit("session_shutdown", {});
});

test("shows spinner while running, marks aborted without checkmark, and prefers real error line", async () => {
  const h = createHarness();
  await h.emit("session_start", {});
  await h.emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "e-1", name: "read" },
        { type: "toolCall", id: "e-2", name: "bash" },
      ],
    },
  });

  const ui = { requestRender: () => {} };
  const c1 = new ToolExecutionComponent("read", "e-1", { path: "x.ts" }, {}, h.wrap("read", undefined), ui, process.cwd());
  const c2 = new ToolExecutionComponent("bash", "e-2", { command: "false" }, {}, h.wrap("bash", undefined), ui, process.cwd());
  c1.markExecutionStarted();
  c2.markExecutionStarted();
  c1.updateResult({ content: [{ type: "text", text: "done" }], durationMs: 100 }, false);
  c2.updateResult({ content: [{ type: "text", text: "partial" }], durationMs: 0 }, true);

  const runningText = stripAnsi(c1.render(100).join("\n"));
  assert.match(runningText, /╭─ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] bash/);
  assert.match(runningText, /1\/2/);

  // Aborting mid-run must render ■ aborted, never ✓
  await h.emit("agent_end", {});
  const abortedText = stripAnsi(c1.render(100).join("\n"));
  assert.match(abortedText, /╭─ ■ 2 calls/);
  assert.match(abortedText, /aborted/);
  assert.doesNotMatch(abortedText, /✓/);

  // Error result skips banner stdout and surfaces real error line inside the box
  c2.updateResult(
    {
      content: [{ type: "text", text: "> persona-pi-extensions@1.0.0 test\nError: Command exited with code 1" }],
      isError: true,
      durationMs: 500,
    },
    false,
  );
  const errLines = c1.render(100).map(stripAnsi);
  assert.equal(errLines.length, 5, "leading blank + top + targets + error detail + bottom");
  assert.match(errLines[1], /╭─ ✕ 2 calls · 1 failed/);
  assert.match(errLines[3], /bash: Error: Command exited with code 1/);
  assert.match(errLines[3], /展开/);

  await h.emit("session_shutdown", {});
});

test("folds restored historical sessions, keeps long path tail, and passes HTML export through", async () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "h-1", name: "edit" },
          { type: "toolCall", id: "h-2", name: "read" },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "h-1", timestamp: 2000, durationMs: 120, isError: false } },
    { type: "message", message: { role: "toolResult", toolCallId: "h-2", timestamp: 2500, durationMs: 250, isError: false } },
  ];
  const h = createHarness({ branch });
  await h.emit("session_start", {});

  const baseEdit = {
    renderShell: "self",
    renderCall: () => new Text("SELF_CALL", 0, 0),
    renderResult: () => new Text("SELF_RES", 0, 0),
  };
  const ui = { requestRender: () => {} };
  const c1 = new ToolExecutionComponent(
    "bash",
    "h-1",
    { command: 'cd "C:/Users/Lenovo/.pi/agent/git/github.com/rhine9473/persona-pi-extensions" && npm test && git push origin main' },
    {},
    h.wrap("bash", undefined),
    ui,
    process.cwd(),
  );
  const c2 = new ToolExecutionComponent("read", "h-2", { path: "b.ts" }, {}, h.wrap("read", undefined), ui, process.cwd());
  c1.updateResult({ content: [{ type: "text", text: "ok" }], durationMs: 120 }, false);
  c2.updateResult({ content: [{ type: "text", text: "ok" }], durationMs: 250 }, false);

  const summary = stripAnsi(c1.render(120).join("\n"));
  assert.match(summary, /╭─ ✓ 2 calls/);
  assert.match(summary, /bash npm test && git push origin main · read b\.ts/);
  assert.equal(c2.render(120).length, 0);

  // Expanding single self-shell edit preserves its self layout cleanly
  const h2 = createHarness({
    branch: [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "s-1", name: "edit" }] } },
    ],
  });
  await h2.emit("session_start", {});
  const cSelf = new ToolExecutionComponent("edit", "s-1", { path: "b.ts" }, {}, h2.wrap("edit", baseEdit), ui, process.cwd());
  cSelf.updateResult({ content: [{ type: "text", text: "edited" }], durationMs: 100 }, false);
  h2.setExpanded(true);
  cSelf.setExpanded(true);
  assert.match(stripAnsi(cSelf.render(90).join("\n")), /SELF_CALL[\s\S]*SELF_RES/);

  // Export path: executionStarted && argsComplete on first renderCall
  h.setExpanded(false);
  const pres = h.wrap("custom_tool", {
    renderCall: (args) => new Text(`EXPORT_CALL ${args.x}`, 0, 0),
    renderResult: () => new Text("EXPORT_RES", 0, 0),
  });
  const exportedCall = pres.renderCall(
    { x: 1 },
    { fg: (_c, t) => t, bold: (t) => t },
    {
      args: { x: 1 },
      toolCallId: "exp-1",
      invalidate: () => {},
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: true,
      isError: false,
      durationMs: 50,
      outputPad: 1,
      keyText: () => "",
      keyHint: () => "",
    },
  );
  assert.equal(exportedCall.render(80)[0].trim(), "EXPORT_CALL 1");

  await h.emit("session_shutdown", {});
});

test("renders codemode nested calls, live status, pure JS fallback, wall time, and real error lines", async () => {
  const h = createHarness();
  await h.emit("session_start", {});

  const ui = { requestRender: () => {} };

  // 1. Live partial update -> completed codemode with nested calls + Script header wall time
  await h.emit("message_update", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "cm-1", name: "codemode" }],
    },
  });
  const realCodemode = createCodemodeToolDefinition();
  const cm = new ToolExecutionComponent(
    "codemode",
    "cm-1",
    { code: 'const a = await tools.read({ path: "src/index.ts" });\nawait tools.bash({ command: "npm test" });\nreturn a;' },
    {},
    h.wrap("codemode", realCodemode),
    ui,
    process.cwd(),
  );
  cm.markExecutionStarted();
  cm.updateResult(
    {
      content: [],
      details: {
        calls: [
          { id: "c1", name: "read", args: '{"path":"src/index.ts"}', status: "ok", durationMs: 12 },
          { id: "c2", name: "bash", args: '{"command":"cd /repo && npm test"}', status: "running" },
        ],
      },
    },
    true,
  );
  const running = stripAnsi(cm.render(100).join("\n"));
  assert.match(running, /╭─ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] codemode/);
  assert.match(running, /✓ read index\.ts · … bash npm test/);

  cm.updateResult(
    {
      content: [{ type: "text", text: "Script completed\nWall time 0.42 seconds\nOutput:\nline 1\nline 2\n" }],
      details: {
        calls: [
          { id: "c1", name: "read", args: '{"path":"src/index.ts"}', status: "ok", durationMs: 12 },
          { id: "c2", name: "bash", args: '{"command":"cd /repo && npm test"}', status: "ok", durationMs: 390 },
        ],
      },
    },
    false,
  );
  const doneLines = cm.render(100).map(stripAnsi);
  assert.equal(doneLines.length, 4);
  assert.match(doneLines[1], /^ ╭─ ✓ codemode ─+ 2 次调用 · 2 行 · 0\.4s ─╮$/);
  assert.match(doneLines[2], /^ │ ✓ read index\.ts · ✓ bash npm test\s+│$/);

  // Ctrl+O expands to Pi's real highlighted codemode renderer inside a translucent card
  h.setExpanded(true);
  cm.setExpanded(true);
  const expandedCodemode = assertTranslucentCard(cm.render(100), 100).join("\n");
  assert.match(expandedCodemode, /╭─ ✓ codemode/);
  assert.match(expandedCodemode, /tools\.read/);
  assert.match(expandedCodemode, /line 1/);
  h.setExpanded(false);
  cm.setExpanded(false);

  // 2. Pure JS codemode (0 nested tool calls) still shows script summary + output line count
  await h.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "cm-2", name: "codemode" }],
    },
  });
  const cmPure = new ToolExecutionComponent(
    "codemode",
    "cm-2",
    { code: '// @options: {"timeout_ms": 5000}\nreturn [1, 2, 3].length;' },
    {},
    h.wrap("codemode", realCodemode),
    ui,
    process.cwd(),
  );
  cmPure.updateResult(
    {
      content: [{ type: "text", text: "Script completed\nWall time 0.20 seconds\nOutput:\n3\n" }],
      details: { calls: [] },
    },
    false,
  );
  const pureLines = cmPure.render(100).map(stripAnsi);
  assert.equal(pureLines.length, 4);
  assert.match(pureLines[1], /^ ╭─ ✓ codemode ─+ 1 行 · 0\.2s ─╮$/);
  assert.match(pureLines[2], /^ │ return \[1, 2, 3\]\.length;\s+│$/);

  // 3. Failed codemode surfaces script error instead of generic "Script failed" banner
  await h.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "cm-3", name: "codemode" }],
    },
  });
  const cmErr = new ToolExecutionComponent(
    "codemode",
    "cm-3",
    { code: 'await tools.bash({ command: "false" });' },
    {},
    h.wrap("codemode", undefined),
    ui,
    process.cwd(),
  );
  cmErr.updateResult(
    {
      content: [
        {
          type: "text",
          text: "Script failed\nWall time 0.30 seconds\nOutput:\nReferenceError: nope is not defined\n",
        },
      ],
      details: {
        calls: [{ id: "c3", name: "bash", args: '{"command":"false"}', status: "error", error: "exited 1" }],
      },
      isError: true,
    },
    false,
  );
  const errLines = cmErr.render(100).map(stripAnsi);
  assert.match(errLines[1], /╭─ ✕ codemode ─+ 1 次调用 · 1 行 · 0\.3s ─╮/);
  assert.match(errLines[2], /✕ bash false/);
  assert.match(errLines[3], /codemode: ReferenceError: nope is not defined/);

  await h.emit("session_shutdown", {});
});

test("expanded cards suppress edit Box backgrounds, isolate SGR/OSC8, pass through image lines, and handle narrow widths", async () => {
  const h = createHarness({ expanded: true });
  await h.emit("session_start", {});
  const ui = { requestRender: () => {} };

  // 1. Real Pi editRenderers (renderShell: "self" with internal Box) must not emit opaque bg colors
  await h.emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "ed-1", name: "edit" },
        { type: "toolCall", id: "ansi-1", name: "bash" },
        { type: "toolCall", id: "img-1", name: "custom_img" },
      ],
    },
  });
  const cEdit = new ToolExecutionComponent(
    "edit",
    "ed-1",
    { path: "a.ts", oldText: "old", newText: "new" },
    {},
    h.wrap("edit", editRenderers),
    ui,
    process.cwd(),
  );
  cEdit.updateResult(
    {
      content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
      details: { diff: "--- a/a.ts\n+++ b/a.ts\n-1 old\n+1 new", firstChangedLine: 1 },
    },
    false,
  );
  cEdit.setExpanded(true);
  const editCard = assertTranslucentCard(cEdit.render(100), 100);
  assert.match(editCard.join("\n"), /╭─ ✓ edit/);
  assert.match(editCard.join("\n"), /a\.ts/);

  // 2. Inverse SGR and unclosed OSC-8 hyperlinks are reset before right border padding
  const cAnsi = new ToolExecutionComponent(
    "bash",
    "ansi-1",
    { command: "echo test" },
    {},
    h.wrap("bash", {
      renderCall: () => new Text("\x1b[7minverse\x1b]8;;https://example.test\x07link", 0, 0),
      renderResult: () => new Text("中文输出", 0, 0),
    }),
    ui,
    process.cwd(),
  );
  cAnsi.updateResult({ content: [{ type: "text", text: "中文输出" }], durationMs: 50 }, false);
  cAnsi.setExpanded(true);
  const rawAnsi = cAnsi.render(60);
  assertTranslucentCard(rawAnsi, 60);
  const bodyCallLine = rawAnsi.find((l) => l.includes("inverse"));
  assert.ok(bodyCallLine?.includes("\x1b]8;;\x07\x1b[0m"), "must close OSC-8 and reset SGR before right border");
  assert.equal(visibleWidth(stripAnsi(rawAnsi[1])), 59);
  assert.equal(visibleWidth(stripAnsi(bodyCallLine)), 59);

  // Narrow width fallback must never overflow
  for (const line of cAnsi.render(16)) {
    assert.ok(visibleWidth(line) <= 16, `narrow overflow: ${visibleWidth(line)} > 16`);
  }

  // 3. Aborted status in expanded mode uses ■ aborted rather than running/pending
  await h.emit("message_end", {
    message: { role: "assistant", content: [{ type: "toolCall", id: "ab-1", name: "bash" }] },
  });
  const cAbort = new ToolExecutionComponent(
    "bash",
    "ab-1",
    { command: "sleep 10" },
    {},
    h.wrap("bash", undefined),
    ui,
    process.cwd(),
  );
  cAbort.markExecutionStarted();
  await h.emit("agent_end", {});
  cAbort.setExpanded(true);
  assert.match(assertTranslucentCard(cAbort.render(80), 80)[1], /╭─ ■ bash .*aborted/);

  // 4. Image escape sequences pass through unframed and untruncated
  const kittySeq = "\x1b_Ga=T,f=100;AAAA\x1b\\";
  const cImg = new ToolExecutionComponent(
    "custom_img",
    "img-1",
    { path: "pic.png" },
    {},
    h.wrap("custom_img", {
      renderCall: () => new Text("show pic.png", 0, 0),
      renderResult: () => new Text(kittySeq, 0, 0),
    }),
    ui,
    process.cwd(),
  );
  cImg.updateResult({ content: [{ type: "text", text: "" }], durationMs: 10 }, false);
  cImg.setExpanded(true);
  const imgLines = cImg.render(80);
  assert.ok(
    imgLines.some((line) => line.includes(kittySeq) && !line.includes("│")),
    "Kitty graphic line must pass through untruncated and unframed",
  );

  await h.emit("session_shutdown", {});
});
