import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamAntigravity } from "../src/stream/stream.js";
import { ANTIGRAVITY_MODELS } from "../src/models/index.js";
import { listAccounts, promoteAccountToPrimary, rememberAccount } from "../src/auth/accounts.js";

const savedFetch = globalThis.fetch;
const savedPrewarm = process.env.ANTIGRAVITY_NO_PREWARM;
process.env.ANTIGRAVITY_NO_PREWARM = "1";
const bodies: any[] = [];
const model = { ...ANTIGRAVITY_MODELS[0], api: "antigravity", provider: "antigravity" } as Model<Api>;
const options = { apiKey: JSON.stringify({ token: "test", projectId: "test-project" }), sessionId: "recovery-test" };
try {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (++calls === 1) throw new Error("fetch failed");
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const first = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(calls, 2, "transport errors try the next endpoint");
  assert.notEqual(bodies[0].request.sessionId, bodies[1].request.sessionId);
  const second = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.notEqual(bodies[1].request.sessionId, bodies[2].request.sessionId);

  // Next turn after a recovery stays sticky on the recovered sessionId instead of
  // snapping back to the stalled/cache-wiped original sessionId.
  const nextTurn = await streamAntigravity(
    model,
    { messages: [{ role: "user", content: "next", timestamp: 1 }, second] },
    options,
  ).result();
  assert.equal(nextTurn.stopReason, "stop", nextTurn.errorMessage);
  assert.equal(bodies[3].request.sessionId, bodies[2].request.sessionId);

  // Mid-stream termination (missing finishReason) rotates sessionId on subsequent retry.
  const streamOpts = { ...options, sessionId: "mid-stream-recovery-test" };
  const streamBodies: any[] = [];
  let streamCalls = 0;
  globalThis.fetch = (async (_url, init) => {
    streamBodies.push(JSON.parse(String(init?.body)));
    if (++streamCalls === 1) {
      return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n');
    }
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const abortedMid = await streamAntigravity(model, { messages: [] }, streamOpts).result();
  assert.equal(abortedMid.stopReason, "error");
  const retriedMid = await streamAntigravity(model, { messages: [] }, streamOpts).result();
  assert.equal(retriedMid.stopReason, "stop", retriedMid.errorMessage);
  assert.notEqual(streamBodies[0].request.sessionId, streamBodies[1].request.sessionId);

  globalThis.fetch = (async () => { throw new Error("transport timed out"); }) as typeof fetch;
  const failed = await streamAntigravity(model, { messages: [] }, options).result();
  assert.match(failed.errorMessage ?? "", /timed out/);
  const controller = new AbortController();
  controller.abort();
  let abortCalls = 0;
  globalThis.fetch = (async () => { abortCalls++; throw new Error("cancelled"); }) as typeof fetch;
  const aborted = await streamAntigravity(model, { messages: [] }, { ...options, signal: controller.signal }).result();
  assert.equal(aborted.stopReason, "aborted");
  assert.ok(abortCalls <= 1, "caller cancellation never falls through endpoints");

  // Repro: 2 accounts both return 403 "Verify your account to continue" with validation URLs,
  // triggering hot-failover from account 1 -> account 2, then surfacing the verify URL,
  // and auto-healing back to "ready" once the user verifies in browser and retries.
  const verifyHome = mkdtempSync(join(tmpdir(), "antigravity-verify-repro-"));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(verifyHome, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  try {
    rememberAccount({
      email: "fishk@example.com",
      access: "verify-tok-1",
      refresh: "verify-ref-1",
      expires: Date.now() + 3600_000,
      projectId: "aicode-consumers",
    });
    rememberAccount({
      email: "32580@example.com",
      access: "verify-tok-2",
      refresh: "verify-ref-2",
      expires: Date.now() + 3600_000,
      projectId: "aicode-consumers",
    });
    await promoteAccountToPrimary("fishk@example.com");

    const seenOrder: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      const tok = auth.replace(/^Bearer\s+/i, "");
      seenOrder.push(tok);
      const url =
        tok === "verify-tok-1"
          ? "https://accounts.google.com/v3/signin/continue?plt=TEST1"
          : "https://accounts.google.com/v3/signin/continue?plt=TEST2";
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: `Verify your account to continue. ${url}`,
            status: "PERMISSION_DENIED",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const verifyOpts = {
      apiKey: JSON.stringify({ token: "verify-tok-1", projectId: "aicode-consumers" }),
      sessionId: "verify-repro-1",
    };
    const bothBlocked = await streamAntigravity(model, { messages: [] }, verifyOpts).result();
    assert.equal(bothBlocked.stopReason, "error");
    assert.match(bothBlocked.errorMessage ?? "", /Verify your account/);
    assert.match(bothBlocked.errorMessage ?? "", /accounts\.google\.com\/v3\/signin\/continue/);
    assert.ok(seenOrder.includes("verify-tok-1") && seenOrder.includes("verify-tok-2"), "should hot-failover from fishk to 32580");
    for (const acc of listAccounts()) {
      assert.equal(acc.authStatus, "needs_verify", `${acc.email} should be marked needs_verify`);
      assert.ok(acc.verifyUrl?.includes("accounts.google.com/v3/signin/continue"), "verifyUrl should be saved");
    }

    // Turn 2: User finishes browser verification and retries directly without manual /agy refresh.
    globalThis.fetch = (async () =>
      new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n')) as typeof fetch;
    const healed = await streamAntigravity(
      model,
      { messages: [] },
      {
        apiKey: JSON.stringify({ token: "verify-tok-2", projectId: "aicode-consumers" }),
        sessionId: "verify-repro-2",
      },
    ).result();
    assert.equal(healed.stopReason, "stop", healed.errorMessage);
    const activeAfter = listAccounts().find((a) => a.active);
    assert.equal(activeAfter?.authStatus, "ready", "successful probe after browser verification must auto-heal authStatus to ready");
    assert.equal(activeAfter?.verifyUrl, undefined, "verifyUrl should clear on recovery");
  } finally {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(verifyHome, { recursive: true, force: true });
  }
} finally {
  globalThis.fetch = savedFetch;
  if (savedPrewarm === undefined) delete process.env.ANTIGRAVITY_NO_PREWARM;
  else process.env.ANTIGRAVITY_NO_PREWARM = savedPrewarm;
}
console.log("stream recovery: endpoint fallback, fresh identity, transport errors and cancellation passed");
