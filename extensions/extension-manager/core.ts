import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const BUILTINS = ['mcp', 'llama.cpp', 'codemode', 'tool-search'];
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const clean = (value) => String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export const sourceOf = (pkg) => typeof pkg === 'string' ? pkg : pkg.source;
export const sourceKind = (source) => source.startsWith('npm:') ? 'npm' : /^(git:|https?:|ssh:|git@)/.test(source) ? 'git' : 'local';
export function identity(file) {
  if (file.startsWith('builtin:')) return file;
  let result;
  try { result = fs.realpathSync(file); } catch { result = path.resolve(file); }
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
export function readSnapshot(file) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const data = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`配置不是 JSON 对象：${file}`);
  for (const key of ['extensions', 'packages']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`${key} 必须是数组：${file}`);
  }
  return { file, raw, data };
}

// Reuse Pi's resolver, but never import target extensions or install missing packages.
export function createPreviewManager(api, cwd, agentDir, global, project, trusted) {
  const contents = { global: JSON.stringify(global), project: JSON.stringify(project) };
  const settingsManager = api.SettingsManager.fromStorage({
    withLock(scope, fn) { const next = fn(contents[scope]); if (next !== undefined) contents[scope] = next; },
  }, { projectTrusted: trusted });
  return new api.DefaultPackageManager({ cwd, agentDir, settingsManager, builtinExtensions: BUILTINS });
}
export async function discover(api, cwd, agentDir, global, project = {}, trusted = false) {
  const manager = createPreviewManager(api, cwd, agentDir, global, project, trusted);
  const paths = await manager.resolve(async () => 'skip');
  return { resources: paths.extensions, allResources: [...paths.extensions, ...paths.skills, ...paths.prompts, ...paths.themes], packages: manager.listConfiguredPackages(), manager };
}

function exactTarget(entry, base) {
  const raw = /^[+!\-]/.test(entry) ? entry.slice(1) : entry;
  if (raw.startsWith('builtin:')) return raw;
  if (/[?*{}[\]]/.test(raw)) return undefined;
  const expanded = raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(process.env.USERPROFILE || process.env.HOME || '', raw.slice(2)) : raw;
  return identity(path.resolve(base, expanded));
}
function patchPatterns(current, target, base, enabled, emptyMeansNone) {
  if (current !== undefined && (!Array.isArray(current) || current.some((p) => typeof p !== 'string'))) throw new Error('过滤规则格式错误');
  const targetId = identity(target);
  const relativeTarget = target.startsWith('builtin:') ? target : path.relative(base, target).split(path.sep).join('/');
  if (/[?*{}[\]]/.test(relativeTarget)) throw new Error('路径含 glob 字符，不能安全生成精确规则');
  // [] means no package resources, whereas [+path] alone would enable ALL!
  if (emptyMeansNone && current?.length === 0) return enabled ? [relativeTarget] : [];
  // Keep discovery/include anchors and glob exclusions. Removing a sole plain
  // package include would turn the remaining +/- rules into an allow-all filter.
  const result = (current ?? []).filter((p) => !/^[+\-]/.test(p) || exactTarget(p, base) !== targetId);
  result.push(`${enabled ? '+' : '-'}${relativeTarget}`);
  return result;
}
const PACKAGE_RESOURCE_TYPES = ['extensions', 'skills', 'prompts', 'themes'];
const PACKAGE_DISABLED_STATE = 'extensionManagerDisabled';
export function isPackageDisabled(entry) {
  return entry && typeof entry === 'object' && PACKAGE_RESOURCE_TYPES.every((type) => Array.isArray(entry[type]) && entry[type].length === 0);
}
export function togglePackageConfig(settings, pkg, enabled, selfPath) {
  if (pkg.scope !== 'user') throw new Error('这里只管理全局包');
  if (pkg.installedPath) {
    const root = identity(pkg.installedPath), self = identity(selfPath);
    if (self === root || self.startsWith(`${root}${path.sep}`)) throw new Error('包含管理器的包受保护，不能关闭');
  }
  const result = clone(settings);
  const index = (result.packages ?? []).findIndex((entry) => sourceOf(entry) === pkg.source);
  if (index < 0) throw new Error('包声明已变化，请重开管理器');
  const entry = result.packages[index];
  const next = typeof entry === 'string' ? { source: entry } : clone(entry);
  const previous = next[PACKAGE_DISABLED_STATE];
  if (previous !== undefined && (previous?.version !== 1 || typeof previous.stringSource !== 'boolean' || !previous.filters || typeof previous.filters !== 'object' || Array.isArray(previous.filters))) throw new Error('整包开关的恢复设置无效，未修改');
  if (enabled) {
    if (!isPackageDisabled(next)) {
      if (previous !== undefined) throw new Error('整包关闭后单项设置已变化，未覆盖');
      return result;
    }
    for (const type of PACKAGE_RESOURCE_TYPES) {
      delete next[type];
      if (previous && Object.hasOwn(previous.filters, type)) {
        const patterns = previous.filters[type];
        if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string')) throw new Error('整包开关的恢复规则无效，未修改');
        next[type] = clone(patterns);
      }
    }
    if (!previous && next.autoload === false) delete next.autoload;
    delete next[PACKAGE_DISABLED_STATE];
    result.packages[index] = previous?.stringSource && Object.keys(next).length === 1 ? next.source : next;
  } else {
    if (isPackageDisabled(next)) return result;
    if (previous !== undefined) throw new Error('整包关闭状态与规则不一致，未修改');
    const filters = {};
    for (const type of PACKAGE_RESOURCE_TYPES) {
      if (Object.hasOwn(next, type)) {
        if (!Array.isArray(next[type]) || next[type].some((pattern) => typeof pattern !== 'string')) throw new Error('包资源规则格式错误');
        filters[type] = clone(next[type]);
      }
      next[type] = [];
    }
    next[PACKAGE_DISABLED_STATE] = { version: 1, filters, stringSource: typeof entry === 'string' };
    result.packages[index] = next;
  }
  return result;
}
export function verifyPackageChange(before, after, pkg, enabled, selfPath) {
  const belongs = (r) => r.metadata.origin === 'package' && r.metadata.source === pkg.source && r.metadata.scope === pkg.scope;
  const previous = new Map(before.map((r) => [identity(r.path), r]));
  const current = new Map(after.map((r) => [identity(r.path), r]));
  for (const [id, resource] of previous) {
    if (!belongs(resource) && current.get(id)?.enabled !== resource.enabled) throw new Error('整包开关影响了其他资源，未暂存');
  }
  for (const [id, resource] of current) {
    if (!belongs(resource) && !previous.has(id)) throw new Error('整包开关意外引入其他资源，未暂存');
    if (!enabled && belongs(resource) && resource.enabled) throw new Error('仍有包资源启用，未暂存');
  }
  const self = identity(selfPath);
  if (previous.get(self)?.enabled && !current.get(self)?.enabled) throw new Error('操作可能使管理器不可用，已阻止');
}

export function toggleConfig(settings, resource, agentDir, cwd, enabled, selfPath) {
  if (identity(resource.path) === identity(selfPath)) throw new Error('管理器自身受保护，不能禁用');
  if (!resource.path.startsWith('builtin:') && !fs.existsSync(resource.path) && enabled) throw new Error('资源文件缺失，不能启用');
  const result = clone(settings);
  const base = resource.metadata.scope === 'project' ? path.join(cwd, '.pi') : agentDir;
  if (resource.metadata.origin === 'package') {
    const index = (result.packages ?? []).findIndex((p) => sourceOf(p) === resource.metadata.source);
    if (index < 0) throw new Error('包声明已变化，请刷新');
    const entry = result.packages[index];
    if (isPackageDisabled(entry)) throw new Error('整包已关闭，请先在包页开启整包');
    const pkg = typeof entry === 'string' ? { source: entry } : clone(entry);
    if (pkg.autoload === false) throw new Error('项目包增量请通过 pi config 管理；本界面只读');
    const root = resource.metadata.packageRoot ?? resource.metadata.baseDir;
    if (!root) throw new Error('包根目录未知');
    pkg.extensions = patchPatterns(pkg.extensions, resource.path, root, enabled, true);
    result.packages[index] = pkg;
  } else {
    // A configured, non-autodiscovered path needs a plain discovery anchor.
    const patterns = patchPatterns(result.extensions, resource.path, base, enabled, false);
    const autoRoot = identity(path.join(base, 'extensions'));
    const isAutomatic = identity(resource.path).startsWith(`${autoRoot}${path.sep}`);
    if (!isAutomatic && !resource.path.startsWith('builtin:') && !patterns.some((p) => !/^[+!\-]/.test(p) && exactTarget(p, base) === identity(resource.path))) {
      patterns.unshift(resource.path);
    }
    result.extensions = patterns;
  }
  return result;
}
export function verifySingleChange(before, after, target, enabled, selfPath) {
  const key = identity(target);
  const old = new Map(before.map((r) => [identity(r.path), r.enabled]));
  const next = new Map(after.map((r) => [identity(r.path), r.enabled]));
  if (next.get(key) !== enabled) throw new Error('官方解析器未确认目标状态；未暂存');
  for (const [id, state] of old) {
    if (id !== key && next.get(id) !== state) throw new Error('现有规则导致其他资源状态变化；未暂存，请使用 pi config');
  }
  for (const id of next.keys()) if (!old.has(id) && id !== key) throw new Error('操作意外发现其他资源；未暂存');
  const self = identity(selfPath);
  if (old.get(self) && !next.get(self)) throw new Error('操作可能使管理器不可用，已阻止');
}
export function assertUnchanged(snapshot) {
  const latest = readSnapshot(snapshot.file);
  if (latest.raw !== snapshot.raw) throw new Error(`配置已被其他操作修改，未覆盖：${snapshot.file}`);
}
export function backup(snapshot, backupDir) {
  assertUnchanged(snapshot);
  fs.mkdirSync(backupDir, { recursive: true });
  const destination = path.join(backupDir, `${path.basename(path.dirname(snapshot.file))}-${Date.now()}-${randomUUID()}.json`);
  fs.writeFileSync(destination, JSON.stringify({ originalFile: snapshot.file, existed: snapshot.raw !== null, originalText: snapshot.raw }, null, 2), { flag: 'wx', mode: 0o600 });
  return destination;
}
export function saveSnapshot(snapshot, next, backupDir) {
  const backupPath = backup(snapshot, backupDir);
  const output = JSON.stringify(next, null, 2) + '\n';
  fs.mkdirSync(path.dirname(snapshot.file), { recursive: true });
  const tmp = `${snapshot.file}.extension-manager-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, output, { flag: 'wx', mode: 0o600 });
    assertUnchanged(snapshot);
    fs.renameSync(tmp, snapshot.file);
    const saved = readSnapshot(snapshot.file);
    if (JSON.stringify(saved.data) !== JSON.stringify(next)) throw new Error(`保存后核验失败，备份：${backupPath}`);
    return { snapshot: saved, backupPath };
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
// Invoke Pi's package CLI with argv and piped output, never a shell or a second TUI.
export async function runPackageCommand(cliPath, args, cwd, agentDir, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, ...(signal ? { signal } : {}),
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 300_000);
    child.stdout.on('data', (data) => { stdout = (stdout + data.toString()).slice(-32768); });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-32768); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, killedBy) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, interrupted: timedOut || code === null, reason: timedOut ? '超过 5 分钟超时' : killedBy ?? '' });
    });
  });
}
