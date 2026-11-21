import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function walkCodeFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkCodeFiles(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(ent.name)) out.push(full);
  }
  return out;
}

// 1. Verify all relative imports across extensions/ and shared/ resolve on disk.
const brokenImports = [];
for (const rootDir of [path.join(repoRoot, "extensions"), path.join(repoRoot, "shared")]) {
  for (const file of walkCodeFiles(rootDir)) {
    const src = readFileSync(file, "utf8");
    const re = /(?:from|import)\s*\(?["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (
        file.endsWith(`${path.sep}test-model-discovery.ts`) &&
        spec === "./scripts/probe-model-discovery.mjs"
      ) {
        continue;
      }
      const base = path.resolve(path.dirname(file), spec);
      const candidates = [
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
        `${base}.ts`,
        `${base}.js`,
        `${base}.mjs`,
        path.join(base, "index.ts"),
        path.join(base, "index.js"),
      ];
      if (!candidates.some((c) => existsSync(c))) {
        brokenImports.push(`${path.relative(repoRoot, file)} -> ${spec}`);
      }
    }
  }
}
assert.deepEqual(brokenImports, [], `Broken relative imports:\n${brokenImports.join("\n")}`);

// 2. Verify shared/ asset & extension path resolvers after repo layout changes.
const registerUrl = pathToFileURL(
  path.join(repoRoot, "extensions/providers/pi-provider-antigravity/scripts/register-ts.mjs"),
).href;
await import(registerUrl);

const { resolveOrchestrationSkillDirsOrThrow } = await import(
  pathToFileURL(path.join(repoRoot, "shared/child-session.ts")).href
);
const { OPENPI_OWNER_SOURCE_PATHS } = await import(
  pathToFileURL(path.join(repoRoot, "shared/tool-surface.ts")).href
);
const skillDirs = resolveOrchestrationSkillDirsOrThrow();
assert.ok(
  skillDirs.some((dir) => dir.endsWith(`${path.sep}skills${path.sep}subagents`) || dir.endsWith("/skills/subagents")),
  `expected skills/subagents in ${JSON.stringify(skillDirs)}`,
);
assert.ok(existsSync(OPENPI_OWNER_SOURCE_PATHS.subagents), "subagents source path must exist");

// 3. Verify all declared Pi extensions load cleanly if host pi-coding-agent is available.
const require = createRequire(import.meta.url);
const hostCandidates = [
  process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")
    : "",
  path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent"),
].filter(Boolean);
const hostRoot = hostCandidates.find((dir) => existsSync(path.join(dir, "dist/core/extensions/loader.js")));
if (hostRoot) {
  const { loadExtensions } = await import(
    pathToFileURL(path.join(hostRoot, "dist/core/extensions/loader.js")).href
  );
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const entryPaths = pkg.pi.extensions.map((entry) => path.resolve(repoRoot, entry));
  const res = await loadExtensions(entryPaths, repoRoot);
  assert.equal(res.errors.length, 0, `Extension load errors: ${JSON.stringify(res.errors)}`);
  assert.equal(res.extensions.length, entryPaths.length);
}

// 4. Verify smart-models grouping, name cleanup, and per-model thinking level memory.
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempAgentDir = mkdtempSync(path.join(tmpdir(), "smart-models-check-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;
try {
  const {
    applyModel,
    displayModelName,
    groupModels,
    loadModelThinkingLevel,
    modelSource,
  } = await import(pathToFileURL(path.join(repoRoot, "extensions/ui/pi-ui-smart-models.ts")).href);

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
} finally {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(tempAgentDir, { recursive: true, force: true });
}

console.log("repo checks (imports, shared paths, extension loading, smart-models thinking memory) passed!");
