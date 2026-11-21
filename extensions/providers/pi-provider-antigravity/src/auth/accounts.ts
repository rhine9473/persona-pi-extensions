import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { defaultProjectId } from "../client/client.js";
import type {
  AccountAuthStatus,
  AccountCooldown,
  AntigravityApiKey,
  AntigravityOAuthCredentials,
  CachedAccountUsage,
  HotFailoverEvent,
  QuotaPoolKey,
} from "../types/types.js";
import { loadAntigravitySettings } from "../utils/settings.js";
import { refreshAntigravityToken } from "./oauth.js";

const ACCOUNTS_FILE = "antigravity-accounts.json";
const AUTH_FILE = "auth.json";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_FAILOVER_EVENTS = 25;

export type StoredAccount = AntigravityOAuthCredentials & {
  accountId: string;
  addedAt: number;
  lastUsedAt: number;
  enabled?: boolean;
  order?: number;
  planLabel?: string;
  authStatus?: AccountAuthStatus;
  authError?: string;
  verifyUrl?: string;
  availableModels?: string[];
  poolCooldowns?: Partial<Record<QuotaPoolKey, AccountCooldown>>;
  cachedUsage?: CachedAccountUsage;
};

type AccountsFile = {
  version: 1 | 2;
  activeAccountId?: string;
  accounts: Record<string, StoredAccount>;
};

export type AccountSummary = {
  accountId: string;
  email?: string;
  active: boolean;
  lastUsedAt: number;
  enabled: boolean;
  order: number;
  planLabel?: string;
  authStatus: AccountAuthStatus;
  authError?: string;
  verifyUrl?: string;
  availableModels?: string[];
  poolCooldowns: Partial<Record<QuotaPoolKey, AccountCooldown>>;
  cachedUsage?: CachedAccountUsage;
};

export type FailoverOptions = {
  pool?: QuotaPoolKey;
  modelId?: string;
  reason?: string;
  failedToken?: string;
  cooldownUntil?: number;
  cooldownEstimated?: boolean;
  preserveActiveAccount?: boolean;
  authStatus?: AccountAuthStatus;
  authError?: string;
  verifyUrl?: string;
};

export type AccountSelectionResult =
  | {
      kind: "selected";
      apiKey: AntigravityApiKey;
      account: StoredAccount;
      switchedFrom?: StoredAccount;
    }
  | {
      kind: "all_cooling";
      pool: QuotaPoolKey;
      earliestUntil: number;
    }
  | {
      kind: "none_available";
      reason: string;
    }
  | {
      kind: "unmanaged";
    };

const failoverEvents: HotFailoverEvent[] = [];
const changeListeners = new Set<() => void>();
let roundRobinCursor = 0;

export function onAccountsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyAccountsChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // Ignore UI listener errors.
    }
  }
}

export function getFailoverEvents(): HotFailoverEvent[] {
  return [...failoverEvents];
}

export function getLastFailoverEvent(): HotFailoverEvent | undefined {
  return failoverEvents[0];
}

export function recordFailoverEvent(event: HotFailoverEvent): void {
  failoverEvents.unshift(event);
  if (failoverEvents.length > MAX_FAILOVER_EVENTS) {
    failoverEvents.length = MAX_FAILOVER_EVENTS;
  }
  notifyAccountsChanged();
}

export function poolKeyForModel(modelId: string): QuotaPoolKey {
  const lower = modelId.trim().toLowerCase();
  if (lower.startsWith("gemini-4-argon")) return "argon";
  if (lower.startsWith("claude-") || lower.startsWith("gpt-oss-")) return "claude_gpt";
  return "gemini";
}

export function poolDisplayName(pool: QuotaPoolKey): string {
  if (pool === "argon") return "Argon";
  if (pool === "claude_gpt") return "Claude / GPT";
  return "Gemini";
}

export function parseResetDurationMs(text: string): number | undefined {
  const match = text.match(/Resets?\s+in\s+([^\n.]+)/i);
  const raw = (match?.[1] ?? text).trim();
  let totalMs = 0;
  let matched = false;
  for (const part of raw.matchAll(/(\d+)\s*(d|h|m|s)/gi)) {
    const val = Number.parseInt(part[1] ?? "0", 10);
    const unit = (part[2] ?? "").toLowerCase();
    if (!Number.isFinite(val)) continue;
    matched = true;
    if (unit === "d") totalMs += val * 86_400_000;
    else if (unit === "h") totalMs += val * 3_600_000;
    else if (unit === "m") totalMs += val * 60_000;
    else if (unit === "s") totalMs += val * 1_000;
  }
  return matched && totalMs > 0 ? totalMs : undefined;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function accountsPath(): string {
  return join(agentDir(), ACCOUNTS_FILE);
}

function authPath(): string {
  return join(agentDir(), AUTH_FILE);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

function emptyStore(): AccountsFile {
  return { version: 2, accounts: {} };
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<StoredAccount>;
  return typeof account.refresh === "string" && account.refresh.length > 0;
}

function pruneExpiredCooldowns(account: StoredAccount, now = Date.now()): void {
  if (!account.poolCooldowns) return;
  for (const pool of Object.keys(account.poolCooldowns) as QuotaPoolKey[]) {
    const cd = account.poolCooldowns[pool];
    if (!cd || !Number.isFinite(cd.until) || cd.until <= now) {
      delete account.poolCooldowns[pool];
    }
  }
  if (Object.keys(account.poolCooldowns).length === 0) {
    delete account.poolCooldowns;
  }
}

function normalizeStore(value: Record<string, unknown> | undefined): AccountsFile {
  if (
    !value ||
    (value.version !== 1 && value.version !== 2) ||
    !value.accounts ||
    typeof value.accounts !== "object"
  ) {
    return emptyStore();
  }
  const accounts: Record<string, StoredAccount> = {};
  const now = Date.now();
  for (const [key, raw] of Object.entries(value.accounts as Record<string, unknown>)) {
    if (!isStoredAccount(raw)) continue;
    const accountId =
      typeof raw.accountId === "string" && raw.accountId.trim() ? raw.accountId : key;
    const normalized: StoredAccount = { ...raw, accountId };
    pruneExpiredCooldowns(normalized, now);
    accounts[accountId] = normalized;
  }
  const activeAccountId =
    typeof value.activeAccountId === "string"
      ? value.activeAccountId
      : typeof value.activeEmail === "string"
        ? value.activeEmail
        : undefined;
  return {
    version: 2,
    activeAccountId: activeAccountId && accounts[activeAccountId] ? activeAccountId : undefined,
    accounts,
  };
}

export function loadAccountStore(): AccountsFile {
  return normalizeStore(readJsonObject(accountsPath()));
}

function saveAccountStore(store: AccountsFile): void {
  for (const acc of Object.values(store.accounts)) {
    pruneExpiredCooldowns(acc);
  }
  writePrivateJson(accountsPath(), { ...store, version: 2 });
}

function accountIdFor(credentials: OAuthCredentials): string {
  const email = (credentials as AntigravityOAuthCredentials).email?.trim().toLowerCase();
  if (email) return email;
  return `account-${createHash("sha256").update(credentials.refresh).digest("hex").slice(0, 16)}`;
}

function nextOrder(store: AccountsFile): number {
  let max = -1;
  for (const acc of Object.values(store.accounts)) {
    if (typeof acc.order === "number" && acc.order > max) max = acc.order;
  }
  return max + 1;
}

function accountFromCredentials(
  credentials: AntigravityOAuthCredentials,
  existing?: StoredAccount,
  fallbackOrder?: number,
): StoredAccount {
  const now = Date.now();
  return {
    ...existing,
    ...credentials,
    accountId: existing?.accountId || accountIdFor(credentials),
    addedAt: existing?.addedAt || now,
    lastUsedAt: now,
    enabled: existing?.enabled ?? true,
    order: existing?.order ?? fallbackOrder,
    authStatus: existing?.authStatus ?? "ready",
  };
}

function sortedAccounts(store: AccountsFile): StoredAccount[] {
  return Object.values(store.accounts).sort((a, b) => {
    const orderA = typeof a.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
    const orderB = typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
    return a.accountId.localeCompare(b.accountId);
  });
}

function normalizeOrder(store: AccountsFile): void {
  const ordered = sortedAccounts(store);
  ordered.forEach((acc, idx) => {
    acc.order = idx;
  });
}

function findAccount(
  store: AccountsFile,
  credentials: OAuthCredentials,
): StoredAccount | undefined {
  const email = (credentials as AntigravityOAuthCredentials).email?.trim().toLowerCase();
  return Object.values(store.accounts).find(
    (account) =>
      account.refresh === credentials.refresh ||
      (email !== undefined && account.email?.trim().toLowerCase() === email),
  );
}

function findAccountByToken(store: AccountsFile, token: string): StoredAccount | undefined {
  return Object.values(store.accounts).find((account) => account.access === token);
}

function findAccountId(store: AccountsFile, selector: string): string | undefined {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return undefined;
  const entries = sortedAccounts(store);
  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10);
    if (index >= 1 && index <= entries.length) return entries[index - 1]?.accountId;
    return undefined;
  }
  return entries.find(
    (account) =>
      account.accountId.toLowerCase() === normalized ||
      account.email?.trim().toLowerCase() === normalized,
  )?.accountId;
}

function readAuthFile(): Record<string, unknown> {
  const path = authPath();
  if (!existsSync(path)) return {};
  const parsed = readJsonObject(path);
  if (!parsed) {
    throw new Error("Refusing to overwrite unreadable Pi auth.json");
  }
  return parsed;
}

function writeActiveCredential(account: StoredAccount | undefined): void {
  const auth = readAuthFile();
  if (account) {
    auth.antigravity = {
      type: "oauth",
      email: account.email,
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
      projectId: account.projectId,
    };
  } else {
    delete auth.antigravity;
  }
  writePrivateJson(authPath(), auth);
}

function currentAuthCredentials(): AntigravityOAuthCredentials | undefined {
  const current = readJsonObject(authPath())?.antigravity;
  if (!current || typeof current !== "object") return undefined;
  const record = current as Record<string, unknown>;
  if (typeof record.refresh !== "string" || !record.refresh) return undefined;
  return {
    access: typeof record.access === "string" ? record.access : "",
    refresh: record.refresh,
    expires: typeof record.expires === "number" ? record.expires : 0,
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
  };
}

export function syncCurrentAuth(): void {
  const credentials = currentAuthCredentials();
  if (!credentials) return;
  const store = loadAccountStore();
  const existing = findAccount(store, credentials);
  const account = accountFromCredentials(credentials, existing, nextOrder(store));
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
}

export function rememberAccount(credentials: AntigravityOAuthCredentials): StoredAccount {
  syncCurrentAuth();
  const store = loadAccountStore();
  const existing = findAccount(store, credentials);
  const account = accountFromCredentials(credentials, existing, nextOrder(store));
  account.enabled = true;
  account.authStatus = "ready";
  delete account.authError;
  delete account.verifyUrl;
  delete account.poolCooldowns;
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
  notifyAccountsChanged();
  return account;
}

export function updateRememberedAccount(
  previous: OAuthCredentials,
  credentials: AntigravityOAuthCredentials,
): void {
  const store = loadAccountStore();
  const existing = findAccount(store, previous);
  if (!existing) return;
  const account = accountFromCredentials(credentials, existing);
  account.authStatus = "ready";
  delete account.authError;
  delete account.verifyUrl;
  delete store.accounts[existing.accountId];
  store.accounts[account.accountId] = account;
  if (store.activeAccountId === existing.accountId) {
    store.activeAccountId = account.accountId;
  }
  saveAccountStore(store);
  notifyAccountsChanged();
}

export function listAccounts(): AccountSummary[] {
  syncCurrentAuth();
  const store = loadAccountStore();
  const ordered = sortedAccounts(store);
  return ordered.map((account, index) => ({
    accountId: account.accountId,
    email: account.email,
    active: account.accountId === store.activeAccountId,
    lastUsedAt: account.lastUsedAt,
    enabled: account.enabled !== false,
    order: typeof account.order === "number" ? account.order : index,
    planLabel: account.planLabel ?? account.cachedUsage?.planLabel,
    authStatus: account.authStatus ?? "ready",
    authError: account.authError,
    verifyUrl: account.verifyUrl,
    availableModels: account.availableModels ? [...account.availableModels] : undefined,
    poolCooldowns: { ...(account.poolCooldowns ?? {}) },
    cachedUsage: account.cachedUsage,
  }));
}

export function getAccountBySelector(selector: string): StoredAccount | undefined {
  syncCurrentAuth();
  const store = loadAccountStore();
  const id = findAccountId(store, selector);
  return id ? store.accounts[id] : undefined;
}

async function ensureFresh(account: StoredAccount): Promise<StoredAccount> {
  if (account.access && account.expires > Date.now() + REFRESH_SKEW_MS) return account;
  try {
    const refreshed = await refreshAntigravityToken(account);
    const updated = accountFromCredentials(refreshed, account);
    updated.authStatus = "ready";
    delete updated.authError;
    delete updated.verifyUrl;
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const store = loadAccountStore();
    const target = store.accounts[account.accountId];
    if (target) {
      target.authStatus = "needs_reauth";
      target.authError = message;
      saveAccountStore(store);
      notifyAccountsChanged();
    }
    throw error;
  }
}

export function apiKeyForAccount(account: StoredAccount): AntigravityApiKey {
  const email = account.email?.trim();
  return {
    token: account.access,
    projectId: account.projectId || defaultProjectId(email || "antigravity-default"),
  };
}

export async function getFreshApiKeyForAccount(selector: string): Promise<AntigravityApiKey> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId || !store.accounts[accountId]) {
    throw new Error(`Antigravity account not found: ${selector}`);
  }
  const fresh = await ensureFresh(store.accounts[accountId]!);
  store.accounts[fresh.accountId] = fresh;
  saveAccountStore(store);
  if (store.activeAccountId === fresh.accountId) {
    writeActiveCredential(fresh);
  }
  return apiKeyForAccount(fresh);
}

export async function activateAccount(selector: string): Promise<StoredAccount> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  const existing = store.accounts[accountId];
  if (!existing) throw new Error(`Antigravity account not found: ${selector}`);
  const account = await ensureFresh(existing);
  account.lastUsedAt = Date.now();
  account.authStatus = "ready";
  delete account.authError;
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
  writeActiveCredential(account);
  notifyAccountsChanged();
  return account;
}

export async function promoteAccountToPrimary(selector: string): Promise<StoredAccount> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId || !store.accounts[accountId]) {
    throw new Error(`Antigravity account not found: ${selector}`);
  }
  const ordered = sortedAccounts(store);
  const target = store.accounts[accountId]!;
  const rest = ordered.filter((a) => a.accountId !== accountId);
  [target, ...rest].forEach((acc, idx) => {
    acc.order = idx;
  });
  target.enabled = true;
  saveAccountStore(store);
  return activateAccount(accountId);
}

export function moveAccountOrder(selector: string, delta: -1 | 1): boolean {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) return false;
  normalizeOrder(store);
  const ordered = sortedAccounts(store);
  const idx = ordered.findIndex((a) => a.accountId === accountId);
  const targetIdx = idx + delta;
  if (idx < 0 || targetIdx < 0 || targetIdx >= ordered.length) return false;
  const [moved] = ordered.splice(idx, 1);
  ordered.splice(targetIdx, 0, moved!);
  ordered.forEach((acc, i) => {
    acc.order = i;
  });
  saveAccountStore(store);
  notifyAccountsChanged();
  return true;
}

export function toggleAccountRotation(
  selector: string,
): { ok: true; enabled: boolean; account: StoredAccount } | { ok: false; error: string } {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId || !store.accounts[accountId]) {
    return { ok: false, error: "未找到该账号" };
  }
  const target = store.accounts[accountId]!;
  const currentlyEnabled = target.enabled !== false;
  if (currentlyEnabled) {
    const enabledCount = Object.values(store.accounts).filter((a) => a.enabled !== false).length;
    if (enabledCount <= 1) {
      return { ok: false, error: "至少保留一个参与轮转的账号" };
    }
  }
  target.enabled = !currentlyEnabled;
  saveAccountStore(store);
  notifyAccountsChanged();
  return { ok: true, enabled: target.enabled, account: target };
}

export function markAccountCooldown(
  selectorOrToken: string,
  pool: QuotaPoolKey,
  until: number,
  reason?: string,
  estimated = false,
): void {
  const store = loadAccountStore();
  const acc =
    store.accounts[selectorOrToken] ??
    findAccountByToken(store, selectorOrToken) ??
    (findAccountId(store, selectorOrToken)
      ? store.accounts[findAccountId(store, selectorOrToken)!]
      : undefined);
  if (!acc) return;
  if (!acc.poolCooldowns) acc.poolCooldowns = {};
  acc.poolCooldowns[pool] = { until, reason, estimated };
  saveAccountStore(store);
  notifyAccountsChanged();
}

export function clearAccountCooldown(selector: string, pool?: QuotaPoolKey): boolean {
  const store = loadAccountStore();
  const id = findAccountId(store, selector);
  if (!id || !store.accounts[id]) return false;
  const acc = store.accounts[id]!;
  if (!acc.poolCooldowns) return false;
  if (pool) delete acc.poolCooldowns[pool];
  else delete acc.poolCooldowns;
  saveAccountStore(store);
  notifyAccountsChanged();
  return true;
}

export function markAccountAuthFailure(
  selectorOrToken: string,
  status: AccountAuthStatus,
  error: string,
  verifyUrl?: string,
): void {
  const store = loadAccountStore();
  const acc =
    store.accounts[selectorOrToken] ??
    findAccountByToken(store, selectorOrToken) ??
    (findAccountId(store, selectorOrToken)
      ? store.accounts[findAccountId(store, selectorOrToken)!]
      : undefined);
  if (!acc) return;
  acc.authStatus = status;
  acc.authError = error.slice(0, 300);
  if (verifyUrl) acc.verifyUrl = verifyUrl;
  saveAccountStore(store);
  notifyAccountsChanged();
}

export function recordAccountAvailableModels(selectorOrToken: string, modelIds: string[]): void {
  const store = loadAccountStore();
  const resolvedId = findAccountId(store, selectorOrToken);
  const acc =
    store.accounts[selectorOrToken] ??
    findAccountByToken(store, selectorOrToken) ??
    (resolvedId ? store.accounts[resolvedId] : undefined);
  if (!acc) return;
  const normalized = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (
    acc.availableModels &&
    acc.availableModels.length === normalized.length &&
    acc.availableModels.every((v, idx) => v === normalized[idx])
  ) {
    return;
  }
  acc.availableModels = normalized;
  saveAccountStore(store);
}

export async function listPeerDiscoveryCredentials(
  token: string,
  refresh?: string,
): Promise<Array<{ accountId: string; token: string; projectId: string }>> {
  const store = loadAccountStore();
  const matched =
    findAccountByToken(store, token) ??
    (refresh ? Object.values(store.accounts).find((a) => a.refresh === refresh) : undefined);
  if (!matched) return [];

  const peers: Array<{ accountId: string; token: string; projectId: string }> = [];
  for (const acc of sortedAccounts(store)) {
    if (acc.accountId === matched.accountId) continue;
    if (acc.enabled === false || (acc.authStatus ?? "ready") !== "ready") continue;
    try {
      const fresh = await ensureFresh(acc);
      store.accounts[fresh.accountId] = fresh;
      peers.push({
        accountId: fresh.accountId,
        token: fresh.access,
        projectId: fresh.projectId || defaultProjectId(fresh.email || "antigravity-default"),
      });
    } catch {
      // Skip peers whose refresh fails during catalog merge.
    }
  }
  saveAccountStore(store);
  return peers;
}

export function recordAccountUsage(selector: string, cachedUsage: CachedAccountUsage): void {
  const store = loadAccountStore();
  const id = findAccountId(store, selector);
  if (!id || !store.accounts[id]) return;
  const acc = store.accounts[id]!;
  acc.cachedUsage = cachedUsage;
  if (cachedUsage.planLabel) acc.planLabel = cachedUsage.planLabel;
  if (!cachedUsage.error) {
    acc.authStatus = "ready";
    delete acc.authError;
    delete acc.verifyUrl;
  }
  saveAccountStore(store);
  notifyAccountsChanged();
}

export async function removeAccount(selector: string): Promise<StoredAccount | undefined> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const accountId = findAccountId(store, selector);
  if (!accountId) throw new Error(`Antigravity account not found: ${selector}`);
  delete store.accounts[accountId];
  let next: StoredAccount | undefined;
  if (store.activeAccountId === accountId) {
    next = sortedAccounts(store).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (next) {
      next = await ensureFresh(next);
      next.lastUsedAt = Date.now();
      store.accounts[next.accountId] = next;
    }
    store.activeAccountId = next?.accountId;
    writeActiveCredential(next);
  }
  normalizeOrder(store);
  saveAccountStore(store);
  notifyAccountsChanged();
  return next;
}

function isAccountCoolingForPool(
  account: StoredAccount,
  pool: QuotaPoolKey,
  now = Date.now(),
): AccountCooldown | undefined {
  const cd = account.poolCooldowns?.[pool];
  return cd && cd.until > now ? cd : undefined;
}

function cachedQuotaForPool(account: StoredAccount, pool: QuotaPoolKey): number {
  const p = account.cachedUsage?.pools?.[pool];
  if (!p) return -1;
  return p.remaining ?? p.remaining5h ?? p.remainingWeekly ?? -1;
}

export async function selectAccountForRequest(
  modelId: string,
  fallbackToken?: string,
): Promise<AccountSelectionResult> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const ordered = sortedAccounts(store);
  if (ordered.length === 0) return { kind: "unmanaged" };
  if (
    fallbackToken &&
    !findAccountByToken(store, fallbackToken) &&
    store.accounts[store.activeAccountId ?? ""]?.access !== fallbackToken
  ) {
    // Caller supplied an explicit external/test token not tracked in antigravity-accounts.json.
    return { kind: "unmanaged" };
  }

  const pool = poolKeyForModel(modelId);
  const now = Date.now();
  const enabled = ordered.filter((a) => a.enabled !== false);
  if (enabled.length === 0) {
    return { kind: "none_available", reason: "所有账号均已暂停轮转" };
  }

  const authReady = enabled.filter((a) => (a.authStatus ?? "ready") === "ready");
  if (authReady.length === 0) {
    const verifyAcc = enabled.find((a) => a.authStatus === "needs_verify");
    if (verifyAcc) {
      const link = verifyAcc.verifyUrl ? `（验证链接：${verifyAcc.verifyUrl}）` : "";
      return {
        kind: "none_available",
        reason: `账号需要 Google 浏览器验证后才能继续使用${link}；验证完成后运行 /agy 按 r 刷新即可恢复`,
      };
    }
    return { kind: "none_available", reason: "没有可用的已授权账号，请重新登录" };
  }

  const eligibleByModel = authReady.filter(
    (a) => !a.availableModels || a.availableModels.includes(modelId),
  );
  const candidatePool = eligibleByModel.length > 0 ? eligibleByModel : authReady;

  const healthy = candidatePool.filter((a) => !isAccountCoolingForPool(a, pool, now));
  if (healthy.length === 0) {
    let earliestUntil = Infinity;
    for (const acc of candidatePool) {
      const cd = isAccountCoolingForPool(acc, pool, now);
      if (cd && cd.until < earliestUntil) earliestUntil = cd.until;
    }
    return {
      kind: "all_cooling",
      pool,
      earliestUntil: Number.isFinite(earliestUntil) ? earliestUntil : now + 60_000,
    };
  }

  const settings = loadAntigravitySettings();
  const currentActive = store.activeAccountId ? store.accounts[store.activeAccountId] : undefined;
  const currentActiveCooldown = currentActive
    ? isAccountCoolingForPool(currentActive, pool, now)
    : undefined;
  const currentActiveIneligible = Boolean(
    currentActive?.availableModels && !currentActive.availableModels.includes(modelId),
  );
  let chosen: StoredAccount | undefined;

  if (settings.strategy === "sticky") {
    chosen =
      (currentActive && healthy.find((a) => a.accountId === currentActive.accountId)) ?? healthy[0];
  } else if (settings.strategy === "max-quota") {
    chosen = [...healthy].sort((a, b) => {
      const qa = cachedQuotaForPool(a, pool);
      const qb = cachedQuotaForPool(b, pool);
      if (qa !== qb) return qb - qa;
      return (a.order ?? 0) - (b.order ?? 0);
    })[0];
  } else {
    // round-robin across healthy accounts
    chosen = healthy[roundRobinCursor % healthy.length];
    roundRobinCursor = (roundRobinCursor + 1) % healthy.length;
  }

  if (!chosen) return { kind: "unmanaged" };

  const candidates = [chosen, ...healthy.filter((a) => a.accountId !== chosen!.accountId)];
  for (const candidate of candidates) {
    try {
      const fresh = await ensureFresh(candidate);
      fresh.lastUsedAt = Date.now();
      store.accounts[fresh.accountId] = fresh;
      const switched = currentActive && currentActive.accountId !== fresh.accountId;
      const temporaryBypass = Boolean(
        switched &&
          settings.strategy === "sticky" &&
          (currentActiveCooldown?.estimated === true || currentActiveIneligible) &&
          (currentActive?.authStatus ?? "ready") === "ready",
      );
      if (!temporaryBypass) {
        store.activeAccountId = fresh.accountId;
      }
      saveAccountStore(store);
      if (switched && !temporaryBypass) {
        writeActiveCredential(fresh);
        if (settings.strategy === "sticky" && currentActive) {
          const reason =
            currentActive.authStatus && currentActive.authStatus !== "ready"
              ? "原账号授权失效"
              : `${poolDisplayName(pool)} 池冷却中`;
          recordFailoverEvent({
            at: Date.now(),
            fromAccountId: currentActive.accountId,
            fromEmail: currentActive.email,
            toAccountId: fresh.accountId,
            toEmail: fresh.email,
            pool,
            reason,
          });
        } else {
          notifyAccountsChanged();
        }
      } else if (temporaryBypass) {
        notifyAccountsChanged();
      }
      return {
        kind: "selected",
        apiKey: apiKeyForAccount(fresh),
        account: fresh,
        ...(switched && currentActive ? { switchedFrom: currentActive } : {}),
      };
    } catch {
      // ensureFresh already marked candidate as needs_reauth; continue to next.
    }
  }

  return { kind: "none_available", reason: "所有可用账号的 OAuth 凭据刷新均失败" };
}

/**
 * Switch to the next stored account that has not already been tried in this request.
 * Supports pool cooldowns, auth failures (401/403), and Magpie-style hot failover.
 */
export async function failoverToNextAccount(
  triedAccessTokens: ReadonlySet<string>,
  opts: FailoverOptions = {},
): Promise<(AntigravityApiKey & { accountId?: string; email?: string }) | undefined> {
  syncCurrentAuth();
  const store = loadAccountStore();
  const pool = opts.pool ?? "gemini";
  const now = Date.now();

  let failedAccount: StoredAccount | undefined;
  if (opts.failedToken) {
    failedAccount = findAccountByToken(store, opts.failedToken);
  } else if (store.activeAccountId) {
    failedAccount = store.accounts[store.activeAccountId];
  }

  if (failedAccount) {
    if (opts.authStatus && opts.authStatus !== "ready") {
      failedAccount.authStatus = opts.authStatus;
      if (opts.authError) failedAccount.authError = opts.authError.slice(0, 300);
      if (opts.verifyUrl) failedAccount.verifyUrl = opts.verifyUrl;
    } else if (opts.cooldownUntil && opts.cooldownUntil > now) {
      if (!failedAccount.poolCooldowns) failedAccount.poolCooldowns = {};
      failedAccount.poolCooldowns[pool] = {
        until: opts.cooldownUntil,
        reason: opts.reason,
        estimated: opts.cooldownEstimated,
      };
    }
    store.accounts[failedAccount.accountId] = failedAccount;
    saveAccountStore(store);
  }

  const allReady = sortedAccounts(store).filter((account) => {
    if (account.enabled === false) return false;
    if ((account.authStatus ?? "ready") !== "ready") return false;
    if (triedAccessTokens.has(account.access)) return false;
    if (isAccountCoolingForPool(account, pool, now)) return false;
    return true;
  });
  const modelId = opts.modelId;
  const modelReady = modelId
    ? allReady.filter((account) => !account.availableModels || account.availableModels.includes(modelId))
    : allReady;
  const candidates = modelReady.length > 0 ? modelReady : allReady;

  for (const candidate of candidates) {
    try {
      const account = await ensureFresh(candidate);
      if (!account.access || triedAccessTokens.has(account.access)) continue;
      account.lastUsedAt = Date.now();
      store.accounts[account.accountId] = account;
      if (!opts.preserveActiveAccount) {
        store.activeAccountId = account.accountId;
      }
      saveAccountStore(store);
      if (!opts.preserveActiveAccount) {
        writeActiveCredential(account);
      }

      if (failedAccount) {
        recordFailoverEvent({
          at: Date.now(),
          fromAccountId: failedAccount.accountId,
          fromEmail: failedAccount.email,
          toAccountId: account.accountId,
          toEmail: account.email,
          pool,
          reason: opts.reason ?? "请求失败，自动热切换",
          cooldownUntil: opts.cooldownUntil,
        });
      } else {
        notifyAccountsChanged();
      }

      return {
        ...apiKeyForAccount(account),
        accountId: account.accountId,
        email: account.email,
      };
    } catch {
      // Skip accounts whose refresh token is no longer valid.
    }
  }
  notifyAccountsChanged();
  return undefined;
}
