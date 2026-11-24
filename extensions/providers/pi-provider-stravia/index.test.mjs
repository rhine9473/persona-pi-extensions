import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

await import(pathToFileURL(path.join(repoRoot, "scripts/register-ts.mjs")).href);

test("stravia extension sanitizes Pi opener across Responses, Chat, and Anthropic payloads", async () => {
  const { NEUTRAL_OPENER, sanitizePayload, default: straviaExtension } = await import(
    pathToFileURL(path.join(here, "index.ts")).href
  );

  const stockPrompt =
    "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.\n\n<tools>\n- read\n</tools>";

  const responsesRes = sanitizePayload({
    model: "gemini-4-neon",
    input: [
      { role: "developer", content: stockPrompt },
      { role: "user", content: [{ type: "input_text", text: "running inside pi, a coding agent harness" }] },
    ],
  });
  assert.equal(responsesRes.changed, true);
  assert.equal(responsesRes.value.input[0].content.startsWith(NEUTRAL_OPENER), true);
  assert.equal(responsesRes.value.input[0].content.includes("<tools>"), true);
  // User turns must not be rewritten.
  assert.equal(responsesRes.value.input[1].content[0].text, "running inside pi, a coding agent harness");

  const chatRes = sanitizePayload({
    messages: [{ role: "system", content: stockPrompt }],
  });
  assert.equal(chatRes.changed, true);
  assert.equal(chatRes.value.messages[0].content.startsWith(NEUTRAL_OPENER), true);

  const anthropicRes = sanitizePayload({
    system: [{ type: "text", text: stockPrompt }],
  });
  assert.equal(anthropicRes.changed, true);
  assert.equal(anthropicRes.value.system[0].text.startsWith(NEUTRAL_OPENER), true);

  // Registration must not embed a hardcoded API key and should only sanitize stravia requests.
  let registered;
  let hook;
  straviaExtension({
    registerProvider(name, config) {
      registered = { name, config };
    },
    on(event, fn) {
      if (event === "before_provider_request") hook = fn;
    },
  });
  assert.equal(registered.name, "stravia");
  assert.equal(registered.config.apiKey, undefined);
  assert.equal(hook({ payload: { input: [{ role: "developer", content: stockPrompt }] } }, { model: { provider: "magpie" } }), undefined);
  const sanitized = hook({ payload: { input: [{ role: "developer", content: stockPrompt }] } }, { model: { provider: "stravia" } });
  assert.equal(sanitized.input[0].content.startsWith(NEUTRAL_OPENER), true);
});
