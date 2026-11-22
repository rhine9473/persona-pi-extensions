import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

await import(
  pathToFileURL(
    path.join(repoRoot, "extensions/providers/pi-provider-antigravity/scripts/register-ts.mjs"),
  ).href
);

test("smart-models groups by upstream, cleans names, and remembers thinking levels per model", async (t) => {
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempAgentDir = mkdtempSync(path.join(tmpdir(), "smart-models-check-"));
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  t.after(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(tempAgentDir, { recursive: true, force: true });
  });

  const {
    applyModel,
    displayModelName,
    groupModels,
    loadModelThinkingLevel,
    modelSource,
  } = await import(pathToFileURL(path.join(here, "index.ts")).href);

  const hydro = {
    provider: "antigravity",
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen (Antigravity)",
    contextWindow: 1048576,
    reasoning: true,
  };
  const neon = {
    provider: "antigravity",
    id: "gemini-4-neon",
    name: "Gemini 4 Neon (Antigravity)",
    contextWindow: 1048576,
    reasoning: true,
  };
  const flash = {
    provider: "antigravity",
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Antigravity)",
    contextWindow: 1048576,
    reasoning: true,
  };

  assert.equal(modelSource(hydro).name, "Antigravity");
  assert.equal(displayModelName(hydro), "Gemini 4 Hydrogen");
  const grouped = groupModels([flash, neon, hydro]);
  assert.deepEqual(
    grouped[0].models.map((m) => displayModelName(m)),
    ["Gemini 4 Hydrogen", "Gemini 4 Neon", "Gemini 3.8 Flash"],
  );

  let currentModel = hydro;
  let currentThinking = "high";
  const fakePi = {
    getThinkingLevel: () => currentThinking,
    setThinkingLevel: (lvl) => {
      currentThinking = lvl;
    },
    setModel: async (m) => {
      currentModel = m;
      return true;
    },
  };
  const fakeCtx = {
    get model() {
      return currentModel;
    },
    ui: { notify: () => {} },
  };

  // Switching from hydro (high) to neon with explicit medium remembers both models' levels.
  await applyModel(fakePi, fakeCtx, neon, "medium");
  assert.equal(currentModel.id, "gemini-4-neon");
  assert.equal(currentThinking, "medium");
  assert.equal(loadModelThinkingLevel(hydro), "high");
  assert.equal(loadModelThinkingLevel(neon), "medium");

  // Switching back to hydro without explicit thinking restores "high".
  await applyModel(fakePi, fakeCtx, hydro);
  assert.equal(currentModel.id, "gemini-4-hydrogen");
  assert.equal(currentThinking, "high");

  // Switching back to neon without explicit thinking restores "medium".
  await applyModel(fakePi, fakeCtx, neon);
  assert.equal(currentModel.id, "gemini-4-neon");
  assert.equal(currentThinking, "medium");
});
