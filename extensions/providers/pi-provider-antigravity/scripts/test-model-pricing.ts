import assert from "node:assert/strict";
import {
  ANTIGRAVITY_DISCOVERED_MODEL_COSTS,
  ANTIGRAVITY_MODELS,
  getAntigravityModelCost,
} from "../src/models/index.js";

console.log("Running model pricing tests...");

// Every Flash model used to share one flat placeholder ($0.10 / $0.40 / $0.025),
// which understated Gemini usage. Verify each tier resolves valid pricing without collapsing.
const costOf = (id: string) => ANTIGRAVITY_MODELS.find((m) => m.id === id)?.cost;
for (const id of ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-pro"]) {
  const c = costOf(id);
  assert.ok(c && c.input > 0 && c.output > c.input && c.cacheRead >= 0, `expected valid pricing for ${id}`);
}

// No two Flash tiers may all collapse to a single shared rate by accident.
const flashIds = ANTIGRAVITY_MODELS.filter((m) => /^gemini-.*-flash$/i.test(m.id)).map((m) => m.id);
assert.ok(flashIds.length >= 2, "expected several Flash models to compare");
const flashRates = new Set(flashIds.map((id) => JSON.stringify(costOf(id))));
assert.ok(flashRates.size > 1, "Flash models should not all collapse to a single shared rate");

// Models that only appear through dynamic discovery are priced too.
for (const discoveredId of ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-4-hydrogen"]) {
  assert.ok(ANTIGRAVITY_DISCOVERED_MODEL_COSTS[discoveredId], `expected discovered pricing for ${discoveredId}`);
  const resolved = getAntigravityModelCost(discoveredId);
  assert.ok(resolved && resolved.input > 0 && resolved.output > resolved.input, `expected valid cost for ${discoveredId}`);
}

// A statically shipped model resolves through the same lookup.
assert.deepEqual(getAntigravityModelCost("gemini-3.8-flash"), costOf("gemini-3.8-flash"));

// An unpriced model must return undefined so callers fall back rather than
// publish a made-up number.
assert.equal(getAntigravityModelCost("totally-unknown-model"), undefined);

console.log("Model pricing tests passed!");
