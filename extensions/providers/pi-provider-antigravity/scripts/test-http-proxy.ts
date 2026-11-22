import assert from "node:assert/strict";
import { antigravityFetch, parseWindowsProxyServer } from "../src/utils/http.js";

const proxyEnvNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const originalEnv = new Map(proxyEnvNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
let requestInit: RequestInit | undefined;

for (const name of proxyEnvNames) delete process.env[name];
process.env.HTTPS_PROXY = "socks5://127.0.0.1:1080";
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requestInit = init;
  return new Response(null, { status: 204 });
}) as typeof fetch;

try {
  const response = await antigravityFetch("https://cloudcode-pa.googleapis.com", { method: "HEAD" });
  assert.equal(response.status, 204);
  assert.ok(requestInit);
  assert.equal("dispatcher" in requestInit, false);

  assert.equal(parseWindowsProxyServer("127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(parseWindowsProxyServer("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(
    parseWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7891"),
    "http://127.0.0.1:7891",
  );
  assert.equal(parseWindowsProxyServer("socks=127.0.0.1:1080"), undefined);
} finally {
  globalThis.fetch = originalFetch;
  for (const name of proxyEnvNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("http proxy dispatcher bypass test passed");
