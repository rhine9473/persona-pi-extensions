import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

test("all relative imports across extensions/ and shared/ resolve on disk", () => {
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
});

test("shared orchestration skill and owner source paths exist", async () => {
  await import(
    pathToFileURL(path.join(repoRoot, "scripts/register-ts.mjs")).href
  );
  const { resolveOrchestrationSkillDirsOrThrow } = await import(
    pathToFileURL(path.join(repoRoot, "shared/child-session.ts")).href
  );
  const { OPENPI_OWNER_SOURCE_PATHS } = await import(
    pathToFileURL(path.join(repoRoot, "shared/tool-surface.ts")).href
  );
  const skillDirs = resolveOrchestrationSkillDirsOrThrow();
  assert.ok(
    skillDirs.some(
      (dir) =>
        dir.endsWith(`${path.sep}pi-tool-subagents${path.sep}skills${path.sep}subagents`) ||
        dir.endsWith("/pi-tool-subagents/skills/subagents"),
    ),
    `expected pi-tool-subagents/skills/subagents in ${JSON.stringify(skillDirs)}`,
  );
  assert.ok(existsSync(OPENPI_OWNER_SOURCE_PATHS.subagents), "subagents source path must exist");
});

test("all declared Pi extensions in package.json load cleanly", async (t) => {
  const hostCandidates = [
    process.env.PI_TEST_HOST || "",
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent")
      : "",
    path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent"),
  ].filter(Boolean);
  const hostRoot = hostCandidates.find((dir) => existsSync(path.join(dir, "dist/core/extensions/loader.js")));
  if (!hostRoot) {
    t.skip("host pi-coding-agent not found");
    return;
  }
  const { loadExtensions } = await import(
    pathToFileURL(path.join(hostRoot, "dist/core/extensions/loader.js")).href
  );
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const entryPaths = pkg.pi.extensions.map((entry) => path.resolve(repoRoot, entry));
  const res = await loadExtensions(entryPaths, repoRoot);
  assert.equal(res.errors.length, 0, `Extension load errors: ${JSON.stringify(res.errors)}`);
  assert.equal(res.extensions.length, entryPaths.length);
});
