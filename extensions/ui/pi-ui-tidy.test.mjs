import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const hostRoot = process.env.PI_TEST_HOST || (process.env.APPDATA
  ? path.join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")
  : path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent"));
const hostRequire = createRequire(path.join(hostRoot, "package.json"));
const tuiPath = hostRequire.resolve("@earendil-works/pi-tui");
const { Text, visibleWidth } = await import(pathToFileURL(tuiPath).href);

const { initTheme } = await import(
  pathToFileURL(path.join(hostRoot, "dist/modes/interactive/theme/theme.js")).href
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
const { default: piUiTidyExtension } = await jiti.import(path.join(here, "pi-ui-tidy.ts"));

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
  piUiTidyExtension(pi);
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

test("collapses 3 tools in one assistant message to 1 summary line and restores all on Ctrl+O", async () => {
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
  const c1 = new ToolExecutionComponent("read", "tc-1", { path: "a.ts" }, {}, h.wrap("read", baseDef), ui, process.cwd());
  const c2 = new ToolExecutionComponent("read", "tc-2", { path: "b.ts" }, {}, h.wrap("read", baseDef), ui, process.cwd());
  const c3 = new ToolExecutionComponent("bash", "tc-3", { command: "npm test" }, {}, h.wrap("bash", baseDef), ui, process.cwd());

  for (const c of [c1, c2, c3]) c.markExecutionStarted();
  c1.updateResult({ content: [{ type: "text", text: "ok1" }], durationMs: 200 }, false);
  c2.updateResult({ content: [{ type: "text", text: "ok2" }], durationMs: 300 }, false);
  c3.updateResult({ content: [{ type: "text", text: "ok3" }], durationMs: 1200 }, false);

  const l1 = c1.render(80).map(stripAnsi);
  const l2 = c2.render(80);
  const l3 = c3.render(80);

  assert.equal(l1.length, 2, `expected leading blank + 1 summary line, got ${JSON.stringify(l1)}`);
  assert.equal(l1[0], "");
  assert.match(l1[1], /3 calls/);
  assert.match(l1[1], /read×2/);
  assert.match(l1[1], /bash×1/);
  assert.equal(l2.length, 0, "second tool must collapse to 0 lines");
  assert.equal(l3.length, 0, "third tool must collapse to 0 lines");
  assert.ok(visibleWidth(l1[1]) <= 80);

  // Ctrl+O expand -> every tool renders its full native Box
  h.setExpanded(true);
  for (const c of [c1, c2, c3]) c.setExpanded(true);
  assert.match(c1.render(80).map(stripAnsi).join("\n"), /CALL a\.ts[\s\S]*RES ok1/);
  assert.match(c2.render(80).map(stripAnsi).join("\n"), /CALL b\.ts[\s\S]*RES ok2/);
  assert.match(c3.render(80).map(stripAnsi).join("\n"), /CALL npm test[\s\S]*RES ok3/);

  // Ctrl+O collapse again -> returns to 1 summary line + 0 follower lines
  h.setExpanded(false);
  for (const c of [c1, c2, c3]) c.setExpanded(false);
  assert.equal(c1.render(80).length, 2);
  assert.equal(c2.render(80).length, 0);
  assert.equal(c3.render(80).length, 0);

  await h.emit("session_shutdown", {});
});

test("shows spinner while running and highlights errors on failure", async () => {
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

  const runningLine = stripAnsi(c1.render(100).join("\n"));
  assert.match(runningLine, /bash false/);
  assert.match(runningLine, /1\/2/);

  c2.updateResult({ content: [{ type: "text", text: "Command exited with code 1" }], isError: true, durationMs: 500 }, false);
  const errLine = stripAnsi(c1.render(100).join("\n"));
  assert.match(errLine, /✕/);
  assert.match(errLine, /1 failed \(bash: Command exited with code 1\)/);

  await h.emit("session_shutdown", {});
});

test("collapses restored historical sessions and passes HTML export through untouched", async () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "h-1", name: "read" },
          { type: "toolCall", id: "h-2", name: "edit" },
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
  // Replay does not call markExecutionStarted()
  const c1 = new ToolExecutionComponent("read", "h-1", { path: "a.ts" }, {}, h.wrap("read", undefined), ui, process.cwd());
  const c2 = new ToolExecutionComponent("edit", "h-2", { path: "b.ts" }, {}, h.wrap("edit", baseEdit), ui, process.cwd());
  c1.updateResult({ content: [{ type: "text", text: "ok" }], durationMs: 120 }, false);
  c2.updateResult({ content: [{ type: "text", text: "edited" }], durationMs: 250 }, false);

  assert.match(stripAnsi(c1.render(90).join("\n")), /2 calls · read×1 · edit×1/);
  assert.equal(c2.render(90).length, 0);

  // Expanding self-shell edit preserves its self layout cleanly
  h.setExpanded(true);
  c2.setExpanded(true);
  assert.match(stripAnsi(c2.render(90).join("\n")), /SELF_CALL[\s\S]*SELF_RES/);

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
