/** Stravia local gateway provider and system prompt fingerprint sanitizer. */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASE_URL = "http://127.0.0.1:23471/v1";
export const NEUTRAL_OPENER = "You are a coding agent helping the user with their project.";

const COST_ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const THINKING_TO_HIGH = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
} as const;

const THINKING_TO_XHIGH = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
} as const;

export const STRAVIA_MODELS: ProviderModelConfig[] = [
  {
    id: "gemini-4-neon",
    name: "Gemini 4 Neon",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_TO_XHIGH },
    input: ["text", "image"],
    cost: COST_ZERO,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_TO_XHIGH },
    input: ["text", "image"],
    cost: COST_ZERO,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-4-carbon",
    name: "Gemini 4 Carbon",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_TO_HIGH },
    input: ["text", "image"],
    cost: COST_ZERO,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_TO_HIGH },
    input: ["text", "image"],
    cost: COST_ZERO,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_TO_HIGH },
    input: ["text", "image"],
    cost: COST_ZERO,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_TO_HIGH },
    input: ["text", "image"],
    cost: COST_ZERO,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
];

/**
 * Neutralize Pi and Pi-Bolt system prompt fingerprints that trigger false
 * 429 ResourceExhausted responses on Antigravity upstream targets.
 */
export function sanitizeSystemPrompt(text: string): string {
  return text
    .replace(
      /^You are a coding assistant running inside [^.]*\.\s*Help users inspect files, run commands, and modify code\./i,
      NEUTRAL_OPENER,
    )
    .replace(
      /running inside pi-bolt,\s*a build of pi\s*\(a coding agent harness\)\s*compiled ahead of time/gi,
      "running inside your development environment",
    )
    .replace(
      /inside pi-bolt,\s*a build of pi\s*\(a coding agent harness\)\s*compiled ahead of time/gi,
      "inside your development environment",
    )
    .replace(
      /running inside pi(?:-bolt)?,\s*a coding agent harness/gi,
      "running inside your development environment",
    )
    .replace(
      /inside pi(?:-bolt)?,\s*a coding agent harness/gi,
      "inside your development environment",
    )
    .replace(
      /(coding assistant )running inside pi(?:-bolt)?(?=[.,!?;:\s]|$)(?!\.\w)/gi,
      "$1running inside your development environment",
    )
    .replace(
      /(coding agent )inside pi(?:-bolt)?(?=[.,!?;:\s]|$)(?!\.\w)/gi,
      "$1inside your development environment",
    )
    .replace(/\bpractical,\s*and tool-aware\./gi, "practical, and tool aware.")
    .replace(
      /codemode scripts and non-LLM models/gi,
      "codemode scripts (docs/codemode.md), non-LLM models",
    );
}

function sanitizeTextPartList(parts: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(parts)) return { value: parts, changed: false };
  let changed = false;
  const next = parts.map((part) => {
    if (!part || typeof part !== "object") return part;
    const record = part as Record<string, unknown>;
    if (typeof record.text !== "string") return part;
    const sanitized = sanitizeSystemPrompt(record.text);
    if (sanitized === record.text) return part;
    changed = true;
    return { ...record, text: sanitized };
  });
  return { value: changed ? next : parts, changed };
}

function sanitizeRoleMessages(messages: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(messages)) return { value: messages, changed: false };
  let changed = false;
  const next = messages.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (record.role !== "developer" && record.role !== "system") return item;
    if (typeof record.content === "string") {
      const sanitized = sanitizeSystemPrompt(record.content);
      if (sanitized === record.content) return item;
      changed = true;
      return { ...record, content: sanitized };
    }
    const parts = sanitizeTextPartList(record.content);
    if (!parts.changed) return item;
    changed = true;
    return { ...record, content: parts.value };
  });
  return { value: changed ? next : messages, changed };
}

export function sanitizePayload(payload: unknown): { value: unknown; changed: boolean } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { value: payload, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };

  if (typeof next.instructions === "string") {
    const sanitized = sanitizeSystemPrompt(next.instructions);
    if (sanitized !== next.instructions) {
      next.instructions = sanitized;
      changed = true;
    }
  }

  // OpenAI Responses API
  const inputRes = sanitizeRoleMessages(next.input);
  if (inputRes.changed) {
    next.input = inputRes.value;
    changed = true;
  }

  // OpenAI Chat Completions API
  const messagesRes = sanitizeRoleMessages(next.messages);
  if (messagesRes.changed) {
    next.messages = messagesRes.value;
    changed = true;
  }

  // Anthropic Messages API
  if (typeof next.system === "string") {
    const sanitized = sanitizeSystemPrompt(next.system);
    if (sanitized !== next.system) {
      next.system = sanitized;
      changed = true;
    }
  } else {
    const sysParts = sanitizeTextPartList(next.system);
    if (sysParts.changed) {
      next.system = sysParts.value;
      changed = true;
    }
  }

  return { value: changed ? next : payload, changed };
}

export default function straviaExtension(pi: ExtensionAPI) {
  const baseUrl = process.env.STRAVIA_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const hasEnvKey = Boolean(process.env.STRAVIA_API_KEY?.trim());

  pi.registerProvider("stravia", {
    name: "Stravia",
    baseUrl,
    ...(hasEnvKey ? { apiKey: "$STRAVIA_API_KEY" } : {}),
    api: "openai-responses",
    authHeader: true,
    models: STRAVIA_MODELS,
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "stravia") return undefined;
    const result = sanitizePayload(event.payload);
    return result.changed ? result.value : undefined;
  });
}
