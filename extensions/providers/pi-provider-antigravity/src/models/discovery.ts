import { createHash } from "node:crypto";
import type {
  Api,
  Credential,
  Model,
  ModelsStoreEntry,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { getApiKey, listPeerDiscoveryCredentials, recordAccountAvailableModels } from "../auth/index.js";
import { DEFAULT_ENDPOINT, fetchAvailableModelsCatalog, parseApiKey } from "../client/index.js";
import { ANTIGRAVITY_API, type AntigravityModelConfig } from "../types/types.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { buildAntigravityCatalog, resolvedCatalog, type AntigravityCatalog } from "./grouping.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  getCurrentAntigravityCatalog,
  registerDiscoveredModelEnums,
  restoreDynamicModelEnums,
  snapshotDynamicModelEnums,
} from "./models.js";

export const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const ANTIGRAVITY_PERSIST_KEY = "pi-antigravity";
export const CATALOG_SCHEMA_VERSION = 6;

type PersistedAntigravityCatalog = {
  catalog: AntigravityCatalog;
  checkedAt: number;
  modelEnums: Record<string, string>;
  schemaVersion: number;
  credentialKey: string;
};

export function getCatalogRefreshIntervalMs(): number {
  const envVal =
    antigravityEnv("CATALOG_REFRESH_INTERVAL_MS") ?? antigravityEnv("REFRESH_INTERVAL_MS");
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_CATALOG_REFRESH_INTERVAL_MS;
}

const fallbackCatalog = (): AntigravityCatalog => ({
  models: ANTIGRAVITY_MODELS,
  routing: { ...ANTIGRAVITY_ROUTING },
});

/** Restore provider state supplied by Pi before checking offline mode or refresh TTL. */
export function hydrateAntigravityCatalog(stored: unknown): number {
  if (!isRecord(stored)) return 0;
  const persisted = stored[ANTIGRAVITY_PERSIST_KEY];
  if (!isRecord(persisted)) return 0;

  if (isStringMap(persisted.modelEnums)) restoreDynamicModelEnums(persisted.modelEnums);
  if (isCatalog(persisted.catalog)) applyAntigravityCatalog(persisted.catalog);
  return typeof persisted.checkedAt === "number" && persisted.checkedAt > 0
    ? persisted.checkedAt
    : 0;
}

export async function discoverAntigravityModels(
  apiKey: string,
  signal?: AbortSignal,
  refreshToken?: string,
): Promise<AntigravityCatalog> {
  const creds = parseApiKey(apiKey);
  const available = await fetchAvailableModelsCatalog(creds.token, creds.projectId, signal);
  const models = available.data.models;
  if (!models || Object.keys(models).length === 0) {
    throw new Error("Antigravity returned an empty or unrecognized model catalog");
  }
  registerDiscoveredModelEnums(models);
  const primaryCatalog = buildAntigravityCatalog(
    models,
    fallbackCatalog(),
    available.data.agentModelSorts,
  );
  recordAccountAvailableModels(
    creds.token,
    primaryCatalog.models.map((m) => m.id),
  );

  // Merge catalogs across other enabled ready accounts so subscription-gated models
  // (e.g. Gemini 4 Carbon on an Ultra account) still appear when a Pro account is primary.
  const peers = await listPeerDiscoveryCredentials(creds.token, refreshToken);
  if (peers.length === 0) return primaryCatalog;

  const mergedRawModels = { ...models };
  const mergedSorts = Array.isArray(available.data.agentModelSorts)
    ? [...available.data.agentModelSorts]
    : [];
  const peerResults = await Promise.allSettled(
    peers.map(async (peer) => ({
      peer,
      res: await fetchAvailableModelsCatalog(peer.token, peer.projectId, signal),
    })),
  );
  for (const outcome of peerResults) {
    if (outcome.status !== "fulfilled") continue;
    const { peer, res } = outcome.value;
    const peerModels = res.data.models;
    if (!peerModels || Object.keys(peerModels).length === 0) continue;
    registerDiscoveredModelEnums(peerModels);
    try {
      const peerCatalog = buildAntigravityCatalog(
        peerModels,
        fallbackCatalog(),
        res.data.agentModelSorts,
      );
      recordAccountAvailableModels(
        peer.accountId,
        peerCatalog.models.map((m) => m.id),
      );
    } catch {
      // Ignore empty peer catalogs.
    }
    for (const [id, info] of Object.entries(peerModels)) {
      if (!mergedRawModels[id] || mergedRawModels[id]?.disabled === true) {
        mergedRawModels[id] = info;
      }
    }
    if (Array.isArray(res.data.agentModelSorts)) {
      mergedSorts.push(...res.data.agentModelSorts);
    }
  }

  return buildAntigravityCatalog(
    mergedRawModels,
    fallbackCatalog(),
    mergedSorts.length > 0 ? mergedSorts : undefined,
  );
}

export async function refreshAntigravityModels(
  context: RefreshModelsContext,
): Promise<AntigravityModelConfig[]> {
  const checkedAt = hydrateAntigravityCatalog(context.stored);
  const current = getCurrentAntigravityCatalog();
  if (!context.allowNetwork) return current.models;

  const apiKey = apiKeyFromCredential(context.credential);
  if (!apiKey || context.signal.aborted) return current.models;

  // A different account/project or pre-upgrade cache must not suppress a fresh
  // discovery. Keep hydration above so offline startup still has usable models.
  const parsedPrimary = parseApiKey(apiKey);
  const refreshTok = context.credential?.type === "oauth" ? context.credential.refresh : undefined;
  const peerIds = (await listPeerDiscoveryCredentials(parsedPrimary.token, refreshTok))
    .map((p) => p.accountId)
    .sort();
  const keyParts = [refreshTok ?? apiKey, parsedPrimary.projectId, ...(peerIds.length > 0 ? [peerIds] : [])];
  const credentialKey = createHash("sha256")
    .update(JSON.stringify(keyParts))
    .digest("hex");
  const stored: unknown = context.stored;
  const persisted = isRecord(stored) ? stored[ANTIGRAVITY_PERSIST_KEY] : undefined;
  const sameSource =
    isRecord(persisted) &&
    persisted.schemaVersion === CATALOG_SCHEMA_VERSION &&
    persisted.credentialKey === credentialKey;
  const now = Date.now();
  if (
    !context.force &&
    sameSource &&
    checkedAt > 0 &&
    now >= checkedAt &&
    now - checkedAt < getCatalogRefreshIntervalMs()
  ) {
    return current.models;
  }

  try {
    const discovered = await discoverAntigravityModels(apiKey, context.signal, refreshTok);
    if (context.signal.aborted) return current.models;
    const next = resolvedCatalog(discovered, current);
    if (next.models.length > 0 && discovered.models.length > 0) {
      applyAntigravityCatalog(next);
      const refreshedAt = Date.now();
      await context.publish({
        persist: {
          models: toStoredModels(next.models),
          [ANTIGRAVITY_PERSIST_KEY]: {
            catalog: next,
            checkedAt: refreshedAt,
            modelEnums: snapshotDynamicModelEnums(),
            schemaVersion: CATALOG_SCHEMA_VERSION,
            credentialKey,
          } satisfies PersistedAntigravityCatalog,
        } as unknown as ModelsStoreEntry,
      });
      return next.models;
    }
  } catch (error) {
    // Keep last-known-good models; a failed refresh must not wipe the catalog.
    // Forced/manual refreshes must still report the failure to their caller.
    if (context.force) throw error;
  }

  return getCurrentAntigravityCatalog().models;
}

function isCatalog(value: unknown): value is AntigravityCatalog {
  return (
    isRecord(value) &&
    Array.isArray(value.models) &&
    value.models.length > 0 &&
    isRecord(value.routing)
  );
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function apiKeyFromCredential(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") {
    return typeof credential.key === "string" && credential.key ? credential.key : undefined;
  }
  if (credential.type === "oauth" && typeof credential.access === "string") {
    return getApiKey(credential);
  }
  return undefined;
}

function toStoredModels(models: AntigravityModelConfig[]): Model<Api>[] {
  return models.map((model) => ({
    ...model,
    api: ANTIGRAVITY_API,
    provider: "antigravity",
    baseUrl: DEFAULT_ENDPOINT,
  }));
}
