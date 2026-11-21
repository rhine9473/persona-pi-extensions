import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildRequest,
  capacityAttemptLimit,
  clearCapacityRouteCache,
  isCapacityFailure,
  isGenericResourceExhausted,
  streamAntigravity,
} from "../src/stream/stream.js";
import { ANTIGRAVITY_MODELS } from "../src/models/index.js";
import { promoteAccountToPrimary, rememberAccount } from "../src/auth/accounts.js";

const isolatedHome = mkdtempSync(join(tmpdir(), "antigravity-capacity-test-"));
const savedFetch = globalThis.fetch;
const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ANTIGRAVITY_NO_PREWARM: process.env.ANTIGRAVITY_NO_PREWARM,
  ANTIGRAVITY_CAPACITY_BACKOFF_MS: process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS,
  NOAGY_CAPACITY_BACKOFF_MS: process.env.NOAGY_CAPACITY_BACKOFF_MS,
  ANTIGRAVITY_CAPACITY_ATTEMPTS: process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS,
  NOAGY_CAPACITY_ATTEMPTS: process.env.NOAGY_CAPACITY_ATTEMPTS,
  ANTIGRAVITY_BASE_URL: process.env.ANTIGRAVITY_BASE_URL,
  NOAGY_BASE_URL: process.env.NOAGY_BASE_URL,
  ANTIGRAVITY_RUNTIME_MODEL: process.env.ANTIGRAVITY_RUNTIME_MODEL,
  NOAGY_RUNTIME_MODEL: process.env.NOAGY_RUNTIME_MODEL,
};
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.ANTIGRAVITY_NO_PREWARM = "1";
delete process.env.NOAGY_CAPACITY_BACKOFF_MS;
delete process.env.NOAGY_CAPACITY_ATTEMPTS;
delete process.env.ANTIGRAVITY_BASE_URL;
delete process.env.NOAGY_BASE_URL;
delete process.env.ANTIGRAVITY_RUNTIME_MODEL;
delete process.env.NOAGY_RUNTIME_MODEL;

const model = {
  ...ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.8-flash")!,
  api: "antigravity",
  provider: "antigravity",
} as Model<Api>;
const options = {
  apiKey: JSON.stringify({ token: "test", projectId: "test-project" }),
  sessionId: "capacity-retry-test",
  reasoning: "high" as const,
};
const GENERIC_429 =
  '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}';
const OK_STREAM =
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n';
const EMPTY_STREAM =
  'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n';

function restoreEnv(): void {
  globalThis.fetch = savedFetch;
  clearCapacityRouteCache();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
}

try {
  // Classification: only load-shaped refusals belong to the capacity ladder.
  assert.equal(isCapacityFailure(429, "Resource has been exhausted (e.g. check quota)."), true);
  assert.equal(
    isCapacityFailure(503, '{"error":{"code":503,"message":"No capacity available for model x"}}'),
    true,
  );
  assert.equal(isCapacityFailure(429, "Individual quota reached. Resets in 2h"), false);
  assert.equal(isCapacityFailure(429, "Quota exceeded. Resets in 2h"), false);
  assert.equal(isCapacityFailure(429, "Rate limit exceeded, too many requests"), false);
  assert.equal(isCapacityFailure(400, "Resource has been exhausted"), false);
  assert.equal(isCapacityFailure(undefined, "Resource has been exhausted"), false);

  // Ladder configuration is read per request, so tests and operators can shorten it.
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "5,5";
  delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;
  assert.equal(capacityAttemptLimit(), 3);
  process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS = "2";
  assert.equal(capacityAttemptLimit(), 2);
  delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "not-a-number";
  assert.equal(capacityAttemptLimit(), 5, "invalid override falls back to the default ladder");
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "5";

  // True outer retry + sibling tiers retried on pass 2:
  // Pass 1 fails every endpoint (2) x every tier + compatibility fallback (4) -> 8 calls.
  // Pass 2 fails high (2 endpoints) and then succeeds on medium, proving both that
  // the outer retry ladder runs AND that sibling tiers are walked again on pass 2.
  clearCapacityRouteCache();
  let calls = 0;
  const modelsSeen: string[] = [];
  let firstPassBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    firstPassBody ??= body;
    calls++;
    const reqModel = String(body.model ?? "");
    modelsSeen.push(reqModel);
    // Fail all 8 calls of pass 1 plus the 2 high-tier calls of pass 2; succeed on pass-2 medium.
    if (calls <= 10 || reqModel !== "gemini-3.8-flash-medium") {
      return new Response(GENERIC_429, {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(OK_STREAM);
  }) as typeof fetch;
  const recovered = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  assert.ok(calls >= 11, `expected outer retry into pass-2 sibling tier (calls=${calls})`);
  assert.ok(
    modelsSeen.includes("gemini-3.7-flash-high"),
    `expected queued compatibility fallback during pass 1, saw ${JSON.stringify(modelsSeen)}`,
  );
  assert.equal(modelsSeen.at(-1), "gemini-3.8-flash-medium");
  assert.equal(firstPassBody?.requestType, "agent");

  // Caller abort during a long capacity backoff cancels promptly instead of waiting out the timer.
  clearCapacityRouteCache();
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "60000";
  const controller = new AbortController();
  let abortTestCalls = 0;
  globalThis.fetch = (async () => {
    abortTestCalls++;
    if (abortTestCalls === 8) {
      // Trigger abort shortly after pass 1 finishes and enters the 60s sleep.
      setTimeout(() => controller.abort(new Error("user cancelled")), 25);
    }
    return new Response(GENERIC_429, { status: 429 });
  }) as typeof fetch;
  const abortStart = Date.now();
  const aborted = await streamAntigravity(
    model,
    { messages: [] },
    { ...options, signal: controller.signal },
  ).result();
  const abortElapsed = Date.now() - abortStart;
  assert.equal(aborted.stopReason, "aborted");
  assert.ok(abortElapsed < 5_000, `abort during backoff should cancel promptly (took ${abortElapsed}ms)`);

  // Empty-response recovery stays independent of ANTIGRAVITY_CAPACITY_ATTEMPTS=1.
  clearCapacityRouteCache();
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "1";
  process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS = "1";
  let emptyCalls = 0;
  globalThis.fetch = (async () => {
    emptyCalls++;
    return new Response(emptyCalls <= 2 ? EMPTY_STREAM : OK_STREAM);
  }) as typeof fetch;
  const emptyRecovered = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(emptyRecovered.stopReason, "stop", emptyRecovered.errorMessage);
  assert.equal(emptyCalls, 3, "empty responses still retry up to 3 attempts when capacity attempts=1");
  delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;

  // Exhausting the ladder keeps issue #89's terminal wording: the message must not
  // carry the tokens pi uses to retry a possibly retired model.
  clearCapacityRouteCache();
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "1,1";
  globalThis.fetch = (async () =>
    new Response(GENERIC_429, { status: 429 })) as typeof fetch;
  const throttled = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(throttled.stopReason, "error");
  assert.match(throttled.errorMessage ?? "", /unavailable right now/);
  assert.match(throttled.errorMessage ?? "", /Resource has been exhausted/);
  assert.doesNotMatch(throttled.errorMessage ?? "", /\b429\b/);

  // A hard quota wall still fails immediately: its reset hint is not a capacity blip.
  clearCapacityRouteCache();
  let quotaCalls = 0;
  globalThis.fetch = (async () => {
    quotaCalls++;
    return new Response(
      '{"error":{"code":429,"message":"Individual quota reached. Resets in 2h.","status":"RESOURCE_EXHAUSTED"}}',
      { status: 429 },
    );
  }) as typeof fetch;
  const quotaWall = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(quotaWall.stopReason, "error");
  assert.match(quotaWall.errorMessage ?? "", /Quota reached/);
  assert.ok(quotaCalls <= 2, `a quota wall is not retried across the ladder (calls=${quotaCalls})`);

  assert.equal(isGenericResourceExhausted("Resource has been exhausted (e.g. check quota)."), true);

  // Multi-account capacity failover: borrows healthy second account after 2 queue retries
  // without permanently overwriting the user's sticky primary account.
  clearCapacityRouteCache();
  process.env.PI_CODING_AGENT_DIR = join(isolatedHome, "agent");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "1,1,1,1";
  rememberAccount({
    email: "cap-first@gmail.com",
    access: "cap-tok-1",
    refresh: "cap-ref-1",
    expires: Date.now() + 3600_000,
    projectId: "p-1",
  });
  rememberAccount({
    email: "cap-second@gmail.com",
    access: "cap-tok-2",
    refresh: "cap-ref-2",
    expires: Date.now() + 3600_000,
    projectId: "p-2",
  });
  await promoteAccountToPrimary("cap-first@gmail.com");
  const seenTokens: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const tok = auth.replace(/^Bearer\s+/i, "");
    seenTokens.push(tok);
    if (tok === "cap-tok-1") {
      return new Response(GENERIC_429, { status: 429 });
    }
    return new Response(OK_STREAM);
  }) as typeof fetch;
  const multiRecovered = await streamAntigravity(model, { messages: [] }, {
    apiKey: JSON.stringify({ token: "cap-tok-1", projectId: "p-1" }),
    sessionId: "cap-multi",
  }).result();
  assert.equal(multiRecovered.stopReason, "stop", multiRecovered.errorMessage);
  assert.ok(seenTokens.includes("cap-tok-2"), "should fail over to second healthy account");
  const firstAcctHits = seenTokens.filter((t) => t === "cap-tok-1").length;
  assert.ok(
    firstAcctHits < 5 * 8,
    `expected failover after 3 passes on first account, not full 5-attempt ladder (hits=${firstAcctHits})`,
  );

  // Sticky primary account must remain active while temporary capacity cooldown is active,
  // and recover automatically once cooldown is cleared.
  const { listAccounts, selectAccountForRequest, clearAccountCooldown } = await import("../src/auth/accounts.js");
  assert.equal(
    listAccounts().find((a) => a.email === "cap-first@gmail.com")?.active,
    true,
    "temporary capacity failover should preserve sticky primary account",
  );
  const duringCooldown = await selectAccountForRequest("gemini-4-hydrogen", "cap-tok-1");
  assert.equal(duringCooldown.kind, "selected");
  if (duringCooldown.kind === "selected") {
    assert.equal(duringCooldown.account.email, "cap-second@gmail.com");
  }
  assert.equal(
    listAccounts().find((a) => a.email === "cap-first@gmail.com")?.active,
    true,
    "sticky primary stays preserved during temporary capacity bypass",
  );
  clearAccountCooldown("cap-first@gmail.com");
  const afterCooldown = await selectAccountForRequest("gemini-4-hydrogen", "cap-tok-1");
  assert.equal(afterCooldown.kind, "selected");
  if (afterCooldown.kind === "selected") {
    assert.equal(afterCooldown.account.email, "cap-first@gmail.com", "sticky primary resumes once cooldown expires");
  }

  // Compaction / summarization request caps maxOutputTokens at 32768 without downgrading model,
  // and leaves <skill> tags inside <conversation> untouched.
  const hydroModel = {
    ...model,
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen (Antigravity)",
    maxTokens: 262144,
  } as Model<Api>;
  const summaryReq = buildRequest(
    hydroModel,
    {
      systemPrompt: "You are a context summarization assistant. Summarize cleanly.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "<conversation>\n<skill>keep me</skill>\n</conversation>" }],
          timestamp: Date.now(),
        },
      ],
    },
    "p-1",
    { reasoning: "high" },
    "gemini-4-hydrogen-high",
  );
  assert.equal(summaryReq.model, "gemini-4-hydrogen-high");
  assert.equal(summaryReq.request.generationConfig?.maxOutputTokens, 32768);
  const firstUserText = summaryReq.request.contents
    .flatMap((c) => c.parts)
    .map((p) => ("text" in p ? p.text : ""))
    .join("\n");
  assert.match(firstUserText, /<conversation>[\s\S]*<skill>keep me<\/skill>[\s\S]*<\/conversation>/);

  // 503 No capacity available walks sibling tiers before giving up.
  clearCapacityRouteCache();
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "1";
  const seen503Models: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const reqModel = String(body.model ?? "");
    seen503Models.push(reqModel);
    if (reqModel !== "gemini-3.8-flash-medium") {
      return new Response('{"error":{"code":503,"message":"No capacity available"}}', { status: 503 });
    }
    return new Response(OK_STREAM);
  }) as typeof fetch;
  const recovered503 = await streamAntigravity(
    model,
    { messages: [] },
    { apiKey: JSON.stringify({ token: "standalone-tok", projectId: "p-s" }), reasoning: "high", sessionId: "cap-503" },
  ).result();
  assert.equal(recovered503.stopReason, "stop", recovered503.errorMessage);
  assert.ok(seen503Models.includes("gemini-3.8-flash-medium"), "503 should walk sibling tiers");
} finally {
  delete process.env.PI_CODING_AGENT_DIR;
  restoreEnv();
}

console.log("capacity retry ladder, abort handling, empty recovery, and terminal message passed");
