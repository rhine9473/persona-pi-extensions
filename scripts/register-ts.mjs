import { existsSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hostDir =
  process.env.PI_TEST_HOST ||
  (process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")
    : undefined);
const hostParentUrl =
  hostDir && existsSync(join(hostDir, "package.json"))
    ? pathToFileURL(join(hostDir, "package.json")).href
    : undefined;

function resolveJsToTs(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context.parentURL) {
    try {
      const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(asTs))) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    } catch {
      // Fall through to default resolution.
    }
  }
  try {
    return nextResolve(specifier, context);
  } catch (err) {
    if (hostParentUrl && (specifier.startsWith("@earendil-works/") || specifier === "typebox")) {
      try {
        return nextResolve(specifier, { ...context, parentURL: hostParentUrl });
      } catch {
        // Fall through to original error.
      }
    }
    throw err;
  }
}

if (typeof registerHooks === "function") {
  registerHooks({ resolve: resolveJsToTs });
} else {
  register("./ts-hooks.mjs", import.meta.url);
}
