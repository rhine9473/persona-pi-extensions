import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-antigravity-ui-test-"));

const { buildAntigravityCatalog } = await import("../src/models/grouping.ts");
const { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING } = await import("../src/models/models.ts");
const {
  clearAccountCooldown,
  failoverToNextAccount,
  listAccounts,
  markAccountCooldown,
  moveAccountOrder,
  parseResetDurationMs,
  promoteAccountToPrimary,
  recordAccountUsage,
  rememberAccount,
  selectAccountForRequest,
  toggleAccountRotation,
} = await import("../src/auth/accounts.ts");
const { saveAntigravitySettings } = await import("../src/utils/settings.ts");
const { AntigravityConsole } = await import("../src/ui/console.ts");
const {
  formatAccountsPlainText,
  formatCountdown,
  formatDiagnosticsPlainText,
  formatModelsPlainText,
  formatRelativeAge,
  formatResetIso,
} = await import("../src/ui/format.ts");

// 1. Model deduplication & GPT-OSS casing
const catalog = buildAntigravityCatalog(
  {
    "gemini-4-hydrogen-low": { displayName: "Gemini 4 Hydrogen (Low)", maxTokens: 1048576, maxOutputTokens: 262144 },
    "gemini-4-hydrogen-medium": { displayName: "Gemini 4 Hydrogen (Medium)", maxTokens: 1048576, maxOutputTokens: 262144 },
    "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
    "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", maxTokens: 1048576, maxOutputTokens: 262144 },
    "gemini-4-hydrogen-tiered-high": { displayName: "Gemini 4 Hydrogen (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
    "gemini-4-hydrogen-tiered-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", maxTokens: 1048576, maxOutputTokens: 262144 },
    "gemini-4-hydrogen-sonar": { displayName: "Gemini 4 Hydrogen Sonar", maxTokens: 1048576, maxOutputTokens: 65536 },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", maxTokens: 131072, maxOutputTokens: 32768 },
  },
  { models: ANTIGRAVITY_MODELS, routing: { ...ANTIGRAVITY_ROUTING } },
);

const hydroMatches = catalog.models.filter((m) => m.id.startsWith("gemini-4-hydrogen"));
assert.equal(hydroMatches.length, 2, "tiered hydrogen must fold into base gemini-4-hydrogen, leaving only base + sonar");
assert.equal(
  catalog.routing["gemini-4-hydrogen"]?.routing?.high,
  "gemini-4-hydrogen-high",
  "primary non-tiered route wins",
);
assert.deepEqual(
  catalog.routing["gemini-4-hydrogen"]?.mergedRuntimeIds?.sort(),
  ["gemini-4-hydrogen-tiered-high", "gemini-4-hydrogen-tiered-xhigh"],
);
const gptOss = catalog.models.find((m) => m.id === "gpt-oss-120b");
assert.equal(gptOss?.name, "GPT-OSS 120B (Antigravity)");

// 2. Duration parser
assert.equal(parseResetDurationMs("Individual quota reached. Resets in 1h18m40s."), 4720_000);
assert.equal(parseResetDurationMs("Resets in 2d 3h"), (2 * 24 + 3) * 3600_000);

// 3. Multi-account hot failover, cooldowns, rotation guard, reordering
rememberAccount({
  email: "first@gmail.com",
  access: "tok-first",
  refresh: "ref-first",
  expires: Date.now() + 3600_000,
  projectId: "aicode-consumers",
});
rememberAccount({
  email: "second@gmail.com",
  access: "tok-second",
  refresh: "ref-second",
  expires: Date.now() + 3600_000,
  projectId: "aicode-consumers",
});
rememberAccount({
  email: "third@gmail.com",
  access: "tok-third",
  refresh: "ref-third",
  expires: Date.now() + 3600_000,
  projectId: "aicode-consumers",
});

await promoteAccountToPrimary("first@gmail.com");
assert.equal(listAccounts()[0]?.email, "first@gmail.com");
assert.equal(listAccounts()[0]?.active, true);

// Pause third, cannot pause all
assert.equal(toggleAccountRotation("third@gmail.com").ok, true);
assert.equal(toggleAccountRotation("second@gmail.com").ok, true);
const lastToggle = toggleAccountRotation("first@gmail.com");
assert.equal(lastToggle.ok, false, "must refuse pausing the last enabled account");
toggleAccountRotation("second@gmail.com"); // re-enable second

// Reorder second to top and back
assert.equal(moveAccountOrder("second@gmail.com", -1), true);
assert.equal(listAccounts()[0]?.email, "second@gmail.com");
assert.equal(moveAccountOrder("second@gmail.com", 1), true);
assert.equal(listAccounts()[0]?.email, "first@gmail.com");

// Record usage with distinct 5h and 7d windows + Argon
const now = Date.now();
recordAccountUsage("first@gmail.com", {
  fetchedAt: now - 35_000,
  planLabel: "Google AI Ultra",
  credits: 1200,
  pools: {
    gemini: {
      remaining: 0.15,
      remaining5h: 0.15,
      reset5h: new Date(now + 34 * 60_000).toISOString(),
      remainingWeekly: 0.73,
      resetWeekly: new Date(now + (3 * 24 + 19) * 3600_000).toISOString(),
    },
    claude_gpt: {
      remaining: 0.12,
      remaining5h: 0.12,
      reset5h: new Date(now + (3 * 60 + 8) * 60_000).toISOString(),
      remainingWeekly: 0.56,
      resetWeekly: new Date(now + (6 * 24 + 22) * 3600_000).toISOString(),
    },
    argon: {
      remaining: 1,
      remainingWeekly: 1,
      resetWeekly: new Date(now + (6 * 24 + 5) * 3600_000).toISOString(),
    },
  },
});
recordAccountUsage("second@gmail.com", {
  fetchedAt: now - 35_000,
  planLabel: "Google AI Pro",
  pools: {
    gemini: {
      remaining: 0.88,
      remaining5h: 0.88,
      reset5h: new Date(now + 4 * 3600_000).toISOString(),
      remainingWeekly: 1,
      resetWeekly: new Date(now + (3 * 24 + 18) * 3600_000).toISOString(),
    },
    claude_gpt: {
      remaining: 0.61,
      remaining5h: 1,
      remainingWeekly: 0.61,
    },
  },
});
recordAccountUsage("third@gmail.com", {
  fetchedAt: now - 35_000,
  planLabel: "Google AI Pro",
  pools: {
    gemini: {
      remaining: 0,
      remaining5h: 0,
      reset5h: new Date(now + 25 * 60_000).toISOString(),
      remainingWeekly: 0.88,
    },
    claude_gpt: { remaining: 0.8, remaining5h: 0.8, remainingWeekly: 0.9 },
  },
});

// Failover marks cooldown and switches to second
const next = await failoverToNextAccount(new Set(["tok-first"]), {
  pool: "gemini",
  failedToken: "tok-first",
  cooldownUntil: Date.now() + 3600_000,
  reason: "Gemini 池配额耗尽",
});
assert.equal(next?.token, "tok-second");

// Pre-request selection respects sticky & skips cooling first@gmail.com
const sel = await selectAccountForRequest("gemini-4-hydrogen", "tok-first");
assert.equal(sel.kind, "selected");
if (sel.kind === "selected") {
  assert.equal(sel.account.email, "second@gmail.com");
}

// Cooldown second too -> all_cooling
markAccountCooldown("second@gmail.com", "gemini", Date.now() + 120_000, "test");
const allCool = await selectAccountForRequest("gemini-4-hydrogen", "tok-second");
assert.equal(allCool.kind, "all_cooling");

// Clear cooldown -> recovers
clearAccountCooldown("first@gmail.com");
clearAccountCooldown("second@gmail.com");
saveAntigravitySettings({ strategy: "max-quota" });
const maxSel = await selectAccountForRequest("gemini-4-hydrogen", "tok-second");
assert.equal(maxSel.kind, "selected");
if (maxSel.kind === "selected") {
  assert.equal(maxSel.account.email, "second@gmail.com", "max-quota prefers 88% over 15%");
}

// 4. TUI width invariant tests at 48, 72, 100, 140 across tabs and glyph modes
const fakeTheme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
} as any;
const fakeKb = { matches: () => false } as any;
const fakeCtx = {
  hasUI: true,
  model: { provider: "antigravity", id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen (Antigravity)" },
  modelRegistry: { find: () => undefined, refresh: async () => ({ errors: new Map() }) },
  ui: { notify: () => {}, setStatus: () => {} },
} as any;
const fakePi = {
  getThinkingLevel: () => "high",
  setModel: async () => true,
  setThinkingLevel: () => {},
} as any;

for (const glyphs of ["unicode", "ascii"] as const) {
  saveAntigravitySettings({ glyphs, strategy: "sticky" });
  for (const tab of ["accounts", "models", "diagnostics"] as const) {
    const comp = new AntigravityConsole(
      fakePi,
      fakeCtx,
      { requestRender: () => {}, terminal: { rows: 28, columns: 140 } },
      fakeTheme,
      fakeKb,
      () => {},
      { initialTab: tab },
    );
    for (const width of [48, 72, 100, 140]) {
      const lines = comp.render(width);
      assert.ok(lines.length > 0, `empty render at width ${width}`);
      for (const line of lines) {
        const vw = visibleWidth(line);
        assert.ok(vw <= width, `width overflow (${vw} > ${width}) on tab=${tab} glyphs=${glyphs}: ${line}`);
      }
    }
    comp.handleInput("q");
  }
}

// 4b. Verify 5h/7d dual rendering, Argon full label, Chinese units, and conditional credits column
recordAccountUsage("second@gmail.com", {
  fetchedAt: now - 35_000,
  planLabel: "Google AI Pro",
  pools: {
    gemini: {
      remaining: 0,
      remaining5h: 1,
      reset5h: new Date(now + 4 * 3600_000).toISOString(),
      remainingWeekly: 0,
      resetWeekly: new Date(now + (3 * 24 + 18) * 3600_000).toISOString(),
    },
    claude_gpt: {
      remaining: 0.61,
      remaining5h: 1,
      remainingWeekly: 0.61,
    },
  },
});
const accountsComp = new AntigravityConsole(
  fakePi,
  fakeCtx,
  { requestRender: () => {}, terminal: { rows: 28, columns: 140 } },
  fakeTheme,
  fakeKb,
  () => {},
  { initialTab: "accounts" },
);
const wideAccountsText = accountsComp.render(140).join("\n");
assert.match(wideAccountsText, /5h\s+15%\s+·\s+7d\s+73%/, "top table shows both 5h and 7d percentages");
assert.match(wideAccountsText, /5h 100%\s+·\s+7d 耗尽/, "top table distinguishes 7d exhaustion");
assert.match(wideAccountsText, /5h 耗尽.*7d\s+88%/, "top table distinguishes 5h exhaustion");
assert.match(wideAccountsText, /Gemini 4 Argon\s+7d 额度/, "detail view does not truncate Gemini 4 Argon and unifies window label");
assert.match(wideAccountsText, /积分/, "credits column appears when at least one account has credits");
assert.doesNotMatch(wideAccountsText, /\d+[mh]\s*后重置|\d+s\s*前|\d+\s*天\s*\d+h/, "no mixed English unit + Chinese text");
accountsComp.handleInput("q");

// When no account has credits, hide empty credits column
recordAccountUsage("first@gmail.com", {
  fetchedAt: now - 35_000,
  planLabel: "Google AI Ultra",
  pools: {
    gemini: { remaining: 0.15, remaining5h: 0.15, remainingWeekly: 0.73 },
    claude_gpt: { remaining: 0.12, remaining5h: 0.12, remainingWeekly: 0.56 },
  },
});
const noCreditsComp = new AntigravityConsole(
  fakePi,
  fakeCtx,
  { requestRender: () => {}, terminal: { rows: 28, columns: 140 } },
  fakeTheme,
  fakeKb,
  () => {},
  { initialTab: "accounts" },
);
const noCreditsText = noCreditsComp.render(140).join("\n");
assert.doesNotMatch(noCreditsText, /顺序\s+账号.*积分/, "hide empty credits column when no account reports credits");
noCreditsComp.handleInput("q");

// Chinese duration formatter checks
assert.equal(formatCountdown(now + 45_000, now), "45秒");
assert.equal(formatCountdown(now + (3 * 3600 + 8 * 60) * 1000, now), "3时08分");
assert.equal(formatCountdown(now + (3 * 24 + 18) * 3600_000, now), "3天18时");
assert.equal(formatRelativeAge(now - 35_000, now), "35 秒前");
assert.equal(formatResetIso(new Date(now + (3 * 24 + 19) * 3600_000).toISOString(), now), "3 天 19 小时后重置");
assert.equal(formatResetIso(new Date(now - 120_000).toISOString(), now), "应已重置");

// 5. Plain text formatters
const plain = formatAccountsPlainText(listAccounts(), saveAntigravitySettings({}));
assert.match(plain, /fir\*\*\*@gmail\.com|sec\*\*\*@gmail\.com/);
assert.match(plain, /5h 15% · 7d 73%/);
assert.match(plain, /7d 耗尽/);
const plainModels = formatModelsPlainText(catalog.models, catalog.routing);
assert.match(plainModels, /GPT-OSS 120B/);
const plainDiag = formatDiagnosticsPlainText(listAccounts(), catalog.models.length, {}, saveAntigravitySettings({}));
assert.match(plainDiag, /Antigravity 诊断/);

console.log("hot failover, deduplication, TUI width snapshots (48/72/100/140), and formatters passed!");
