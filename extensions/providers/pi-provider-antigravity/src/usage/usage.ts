import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getFreshApiKeyForAccount,
  listAccounts,
  markAccountAuthFailure,
  poolKeyForModel,
  recordAccountUsage,
} from "../auth/accounts.js";
import {
  antigravityHeaders,
  endpointCandidates,
  extractProjectId,
  fetchAvailableModelsCatalog,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  setLastEndpoint,
  setLastError,
  setLastProjectId,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { isRecord } from "../utils/util.js";
import { getCreditsStatus } from "../utils/credits.js";
import { extractValidationUrl, safeError } from "../utils/security.js";
import { antigravityFetch } from "../utils/http.js";
import { extractRecommendedModelIds } from "../models/grouping.js";
import type {
  AccountUsage,
  ApiErrorBody,
  AvailableModelsRaw,
  CachedAccountUsage,
  CachedPoolQuota,
  CreditBalanceInfo,
  LoadCodeAssistRaw,
  ModelQuotaRow,
  QuotaBucket,
  QuotaGroup,
  QuotaPoolKey,
  QuotaSummaryRaw,
  TierInfo,
  TierRaw,
} from "../types/types.js";

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function remainingPercent(remaining?: number): number | undefined {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

function progressBar(remaining?: number, width = 20): string {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "n/a";
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return resetTime;
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

async function postJson(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ endpoint: string; status: number; data: unknown }> {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      });
      setLastEndpoint(endpoint);
      setLastStatus(res.status);
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { raw: text } satisfies ApiErrorBody;
      }
      if (!res.ok) {
        const errorBody = isRecord(data) ? (data as ApiErrorBody) : undefined;
        lastErrorText =
          typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(res.status)) {
          throw new Error(`${path} failed (${String(res.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: res.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

function parseQuotaSummary(data: unknown): { groups: QuotaGroup[]; description?: string } {
  const summary = (isRecord(data) ? data : {}) as QuotaSummaryRaw;
  const groups: QuotaGroup[] = [];
  for (const group of summary.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const bucket of group.buckets || []) {
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data: unknown): {
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
  agentModelSorts?: unknown;
} {
  const raw = (isRecord(data) ? data : {}) as AvailableModelsRaw;
  const modelsObj = raw.models && isRecord(raw.models) ? raw.models : {};
  const models: ModelQuotaRow[] = [];
  const recommendedIds = extractRecommendedModelIds(raw.agentModelSorts);
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!info || !isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const qi = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(qi.remainingFraction),
      resetTime: qi.resetTime ? String(qi.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended || (recommendedIds?.has(modelId) ?? false),
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
    agentModelSorts: raw.agentModelSorts,
  };
}

export function parseCredits(list: unknown): CreditBalanceInfo[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const result: CreditBalanceInfo[] = [];
  for (const item of list) {
    if (!item || !isRecord(item)) continue;
    const amt = item.creditAmount ?? item.credit_amount;
    const min = item.minimumCreditAmountForUsage ?? item.minimum_credit_amount_for_usage;
    const typ = item.creditType ?? item.credit_type;
    const num = typeof amt === "number" ? amt : typeof amt === "string" ? Number(amt) : undefined;
    if (num !== undefined && Number.isFinite(num)) {
      result.push({
        creditType: typeof typ === "string" ? typ : "GOOGLE_ONE_AI",
        creditAmount: num,
        minimumCreditAmountForUsage:
          typeof min === "number" ? min : typeof min === "string" ? Number(min) : undefined,
      });
    }
  }
  return result.length ? result : undefined;
}

function parseTier(value: unknown): TierInfo | undefined {
  if (!isRecord(value)) return undefined;
  const tier = value as TierRaw;
  if (!tier.id && !tier.name) return undefined;
  const credits = parseCredits(tier.availableCredits ?? tier.available_credits);
  return {
    id: tier.id ? String(tier.id) : undefined,
    name: tier.name ? String(tier.name) : undefined,
    description: tier.description ? String(tier.description) : undefined,
    availableCredits: credits,
  };
}

async function loadCodeAssistSafe(token: string) {
  try {
    return await postJson("/v1internal:loadCodeAssist", token, {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    });
  } catch {
    return null;
  }
}

/**
 * The user-quota-summary RPC is gated behind a paid subscription: free-tier
 * accounts get 403 SUBSCRIPTION_REQUIRED (#3501). It is best-effort diagnostics
 * only — never let it block the rest of the account data (models, tier, project).
 */
async function fetchQuotaSummarySafe(token: string): Promise<
  | { ok: true; result: { endpoint: string; status: number; data: unknown } }
  | {
      ok: false;
      error: string;
    }
> {
  try {
    return { ok: true, result: await postJson("/v1internal:retrieveUserQuotaSummary", token, {}) };
  } catch (error) {
    const msg = safeError(error);
    setLastError(msg);
    return { ok: false, error: msg };
  }
}

export async function fetchAccountUsage(apiKeyRaw?: string): Promise<AccountUsage> {
  const creds = parseApiKey(apiKeyRaw);
  const initialProjectId =
    creds.projectId ||
    resolveProjectId({
      token: creds.token,
      credentialProjectId: creds.projectId,
    });

  // Fetch loadCodeAssist, quota summary, and available models all in parallel
  // to minimize command execution latency.
  const [assistResult, summaryRes, available] = await Promise.all([
    loadCodeAssistSafe(creds.token),
    fetchQuotaSummarySafe(creds.token),
    fetchAvailableModelsCatalog(creds.token, initialProjectId),
  ]);

  // Derive project ID from the loadCodeAssist response or stored project ID.
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    token: creds.token,
    warmedProject: discoveredProject ?? null,
    credentialProjectId: creds.projectId,
  });
  setLastProjectId(projectId);

  const summary = summaryRes.ok ? summaryRes.result : null;
  const quotaSummaryError = summaryRes.ok ? undefined : summaryRes.error;
  const { groups, description } = summary
    ? parseQuotaSummary(summary.data)
    : { groups: [], description: undefined };
  const { models, defaultAgentModelId, agentModelSorts } = parseModels(available.data);

  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const availableCredits =
    paidTier?.availableCredits ??
    productTier?.availableCredits ??
    parseCredits(assistData.availableCredits ?? assistData.available_credits);

  // Google returns currentTier=free-tier even for Google AI Pro accounts.
  // The real subscription lives in paidTier (e.g. g1-pro-tier / Google AI Pro).
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    projectId,
    endpoint: summary?.endpoint ?? available.endpoint ?? assistResult?.endpoint,
    productTier,
    paidTier,
    planLabel,
    availableCredits,
    groups,
    groupDescription: description,
    quotaSummaryError,
    models,
    defaultAgentModelId,
    agentModelSorts,
    fetchedAt: Date.now(),
  };
}

function quotaErrorNote(msg: string): string {
  if (/SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(msg)) {
    return "Aggregate quota summary needs a paid subscription (free-tier can't use that endpoint). Per-model usage is still available via /antigravity.models.";
  }
  return `Aggregate quota summary unavailable: ${msg.slice(0, 160)}`;
}

export function formatUsageSummary(usage: AccountUsage): string {
  const lines: string[] = [];

  if (usage.planLabel) lines.push(usage.planLabel);

  if (!usage.groups.length) {
    if (usage.quotaSummaryError) {
      lines.push(quotaErrorNote(usage.quotaSummaryError));
    } else {
      lines.push("No quota groups returned.");
    }
    return lines.join("\n");
  }

  for (const group of usage.groups) {
    if (lines.length) lines.push("");
    lines.push(group.displayName);
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      lines.push(
        `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${rem ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
      );
    }
  }

  return lines.join("\n").trimEnd();
}

export async function fetchRemainingCredits(apiKeyRaw?: string): Promise<{
  availableCredits?: CreditBalanceInfo[];
  overagesEnabled: boolean;
  planLabel?: string;
}> {
  const creds = parseApiKey(apiKeyRaw);
  const assistResult = await loadCodeAssistSafe(creds.token);
  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const availableCredits =
    paidTier?.availableCredits ??
    productTier?.availableCredits ??
    parseCredits(assistData.availableCredits ?? assistData.available_credits);
  const status = getCreditsStatus();
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    availableCredits,
    overagesEnabled: status.enabled,
    planLabel,
  };
}

export function formatModelsList(usage: AccountUsage, opts?: { all?: boolean }): string {
  const lines: string[] = [];
  lines.push("Antigravity available models");
  lines.push(`project=${usage.projectId}`);
  if (usage.defaultAgentModelId) lines.push(`defaultAgentModel=${usage.defaultAgentModelId}`);
  lines.push("");

  const recommendedIds = extractRecommendedModelIds(usage.agentModelSorts);
  const rows = opts?.all
    ? usage.models
    : recommendedIds && recommendedIds.size > 0
      ? usage.models.filter((m) => recommendedIds.has(m.modelId))
      : usage.models.filter((m) => !/tab_|chat_/i.test(m.modelId));

  if (!rows.length) {
    lines.push("No models returned.");
    return lines.join("\n");
  }

  const maxId = Math.max(...rows.map((m) => m.modelId.length), 8);
  for (const m of rows) {
    const rem = remainingPercent(m.remainingFraction);
    const flags = [
      m.recommended ? "recommended" : "",
      m.supportsThinking ? "thinking" : "",
      m.supportsImages ? "images" : "",
    ]
      .filter(Boolean)
      .join(",");
    const name = m.displayName && m.displayName !== m.modelId ? `  ${m.displayName}` : "";
    lines.push(
      `${m.modelId.padEnd(maxId)}  rem ${rem === undefined ? "  ?" : String(rem).padStart(5)}%  reset ${formatReset(m.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${name}`,
    );
  }
  lines.push("");
  lines.push("Note: remaining % is pool-shared (not a private per-model budget).");
  return lines.join("\n");
}

export async function resolveApiKeyFromContext(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider("antigravity");
  } catch {
    return undefined;
  }
}

function poolKeyForGroup(group: QuotaGroup): QuotaPoolKey | undefined {
  const name = `${group.displayName} ${group.buckets.map((b) => b.bucketId).join(" ")}`.toLowerCase();
  if (/argon/.test(name)) return "argon";
  if (/claude|gpt|3p/.test(name)) return "claude_gpt";
  if (/gemini/.test(name)) return "gemini";
  return undefined;
}

function isFiveHourBucket(bucket: QuotaBucket): boolean {
  const s = `${bucket.bucketId} ${bucket.displayName} ${bucket.window ?? ""}`.toLowerCase();
  return /5\s*h|5_hour|five_hour/.test(s);
}

function isWeeklyBucket(bucket: QuotaBucket): boolean {
  const s = `${bucket.bucketId} ${bucket.displayName} ${bucket.window ?? ""}`.toLowerCase();
  return /week|7\s*d|weekly/.test(s);
}

export function toCachedAccountUsage(usage: AccountUsage): CachedAccountUsage {
  const pools: Partial<Record<QuotaPoolKey, CachedPoolQuota>> = {};

  for (const group of usage.groups) {
    const pool = poolKeyForGroup(group);
    if (!pool) continue;
    const entry: CachedPoolQuota = pools[pool] ?? {};
    for (const bucket of group.buckets) {
      if (isFiveHourBucket(bucket)) {
        if (entry.remaining5h === undefined || bucket.remainingFraction < entry.remaining5h) {
          entry.remaining5h = bucket.remainingFraction;
          entry.reset5h = bucket.resetTime;
        }
      } else if (isWeeklyBucket(bucket)) {
        if (entry.remainingWeekly === undefined || bucket.remainingFraction < entry.remainingWeekly) {
          entry.remainingWeekly = bucket.remainingFraction;
          entry.resetWeekly = bucket.resetTime;
        }
      }
      if (
        entry.remaining === undefined ||
        bucket.remainingFraction < entry.remaining
      ) {
        entry.remaining = bucket.remainingFraction;
        entry.resetTime = bucket.resetTime;
      }
    }
    pools[pool] = entry;
  }

  // Fallback / supplement from per-model quota rows (especially for Argon or free-tier).
  for (const row of usage.models) {
    if (row.remainingFraction === undefined) continue;
    const pool = poolKeyForModel(row.modelId);
    if (!pools[pool]) {
      pools[pool] = {
        remaining: row.remainingFraction,
        resetTime: row.resetTime,
      };
    } else if (pools[pool]!.remaining === undefined) {
      pools[pool]!.remaining = row.remainingFraction;
      pools[pool]!.resetTime = row.resetTime;
    }
  }

  const totalCredits = usage.availableCredits?.reduce(
    (sum, item) => sum + (item.creditAmount ?? 0),
    0,
  );

  return {
    fetchedAt: usage.fetchedAt,
    planLabel: usage.paidTier?.name ?? usage.productTier?.name ?? usage.planLabel,
    tierId: usage.paidTier?.id ?? usage.productTier?.id,
    credits: totalCredits,
    pools,
  };
}

export async function refreshAccountUsageById(accountId: string): Promise<CachedAccountUsage> {
  try {
    const apiKey = await getFreshApiKeyForAccount(accountId);
    const usage = await fetchAccountUsage(JSON.stringify(apiKey));
    const cached = toCachedAccountUsage(usage);
    recordAccountUsage(accountId, cached);
    return cached;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const verifyUrl = extractValidationUrl(msg);
    if (/invalid_grant|re-?login|unauthorized|401/i.test(msg)) {
      markAccountAuthFailure(accountId, "needs_reauth", msg);
    } else if (verifyUrl || /Verification Required/i.test(msg)) {
      markAccountAuthFailure(accountId, "needs_verify", msg, verifyUrl);
    } else if (/403|Terms of Service|disabled/i.test(msg)) {
      markAccountAuthFailure(accountId, "disabled", msg);
    }
    const cached: CachedAccountUsage = {
      fetchedAt: Date.now(),
      pools: {},
      error: msg.slice(0, 220),
    };
    recordAccountUsage(accountId, cached);
    return cached;
  }
}

export async function refreshAllAccountsUsage(
  onAccountDone?: (accountId: string, result: CachedAccountUsage) => void,
): Promise<Map<string, CachedAccountUsage>> {
  const accounts = listAccounts();
  const results = new Map<string, CachedAccountUsage>();
  await Promise.all(
    accounts.map(async (acc) => {
      const res = await refreshAccountUsageById(acc.accountId);
      results.set(acc.accountId, res);
      onAccountDone?.(acc.accountId, res);
    }),
  );
  return results;
}
