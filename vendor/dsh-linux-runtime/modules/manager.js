import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { selectRuntime } from './manifest.js';
import { assertOfficialAssetUrl, isAllowedAssetOrigin } from './asset-installer.js';

const ACTIVE_SCHEMA_VERSION = 1;
const METADATA_SCHEMA_VERSION = 1;
const DEFAULT_GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const ROOTFS_REQUIRED_FILES = [
  'bin/sh',
  'bin/bash',
  'usr/bin/apt-get',
  'usr/bin/dpkg',
  'etc/os-release',
];
const HOST_ENV_ALLOWLIST = new Set([
  'PATH',
  'ANDROID_ROOT',
  'ANDROID_DATA',
  'ANDROID_TZDATA_ROOT',
  'ANDROID_I18N_ROOT',
  'ANDROID_ART_ROOT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'DSH_LINUX_DNS_SERVERS',
]);
const GUEST_ENV_ALLOWLIST = [
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const TERMINATION_GRACE_MS = 1500;
const MAX_GUEST_SMOKE_PROBE_ATTEMPTS = 3;
const ANDROID_NATIVE_PROOT = 'libpocketharness_proot.so';
const ANDROID_NATIVE_PROOT_LOADER = 'libpocketharness_proot_loader.so';
const ANDROID_NATIVE_TALLOC = 'libtalloc.so';
const ANDROID_NATIVE_SHMEM = 'libandroid-shmem.so';
const ROOTFS_COMPAT_LIBRARY = 'opt/pocket-harness/libpocket-linux-compat.so';
const ROOTFS_PRELOAD_FILE = 'etc/ld.so.preload';
const GUEST_PATH_PREFIXES_LIST = [
  '/bin',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
  '/work',
];

/**
 * The guest namespace, deliberately exported.
 *
 * A working directory under one of these prefixes is *never* promoted to a host
 * pass-through: the launcher resolves a configured host directory by its own
 * name before consulting the rootfs, so promoting e.g. `/tmp` or `/etc` would
 * shadow the whole guest subtree of that name. Promoting a directory outside
 * the guest namespace is what makes a real host workspace visible instead.
 */
export const GUEST_PATH_PREFIXES = Object.freeze(GUEST_PATH_PREFIXES_LIST);

/** `true` when `value` names a path inside the guest's own namespace. */
export function isGuestPath(value) {
  return GUEST_PATH_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read/write gate between command execution and installation.
 *
 * Commands run concurrently (shared). Install, reinstall, uninstall and dispose
 * hold the gate exclusively, so a cutover can never race a guest process that is
 * still reading the rootfs being replaced. Management never waits forever on a
 * long-running command: it aborts in-flight children before queueing.
 */
export class ExecutionGate {
  constructor() {
    this.active = 0;
    this.exclusive = false;
    this.waiters = [];
    this.pendingExclusive = 0;
  }

  get busy() {
    return this.exclusive || this.active > 0 || this.pendingExclusive > 0;
  }

  _wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  async acquireExclusive() {
    this.pendingExclusive += 1;
    try {
      while (this.exclusive || this.active > 0) {
        await new Promise((resolve) => this.waiters.push(resolve));
      }
      this.exclusive = true;
    } finally {
      this.pendingExclusive -= 1;
    }
  }

  releaseExclusive() {
    this.exclusive = false;
    this._wake();
  }

  async acquireShared() {
    while (this.exclusive || this.pendingExclusive > 0) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
  }

  releaseShared() {
    this.active -= 1;
    if (this.active === 0) this._wake();
  }
}

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSafeDataDir(directory) {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || resolved.length < 4) {
    throw new TypeError('dataDir must be a non-root private directory');
  }
  return resolved;
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new TypeError(`${field} contains unsafe path characters`);
  }
  return value;
}

function makeId(prefix) {
  try {
    return `${prefix}-${Date.now().toString(36)}-${randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function fileExists(file) {
  try {
    return lstatSync(file).isFile() || lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function directoryExists(directory) {
  try {
    return lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function normaliseCommandResult(result) {
  const value = isObject(result) ? result : {};
  const exitCode = Number.isInteger(value.exitCode)
    ? value.exitCode
    : Number.isInteger(value.code)
      ? value.code
      : null;
  return {
    stdout: value.stdout == null ? '' : String(value.stdout),
    stderr: value.stderr == null ? '' : String(value.stderr),
    exitCode,
    signal: value.signal == null ? null : String(value.signal),
    timedOut: Boolean(value.timedOut),
  };
}

function normaliseRunnerResult(raw) {
  if (raw && typeof raw.then === 'function') {
    return { promise: Promise.resolve(raw), cancel: undefined, forceKill: undefined };
  }
  if (isObject(raw) && raw.promise && typeof raw.promise.then === 'function') {
    return {
      promise: Promise.resolve(raw.promise),
      cancel: typeof raw.cancel === 'function' ? raw.cancel : undefined,
      forceKill: typeof raw.forceKill === 'function' ? raw.forceKill : undefined,
    };
  }
  return { promise: Promise.resolve(raw), cancel: undefined, forceKill: undefined };
}

export function spawnCommand(spec) {
  const detached = process.platform !== 'win32';
  const child = spawn(spec.file, spec.args ?? [], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
    windowsHide: true,
  });
  const capture = (stream) => {
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    stream?.on('data', (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - bytes;
      if (remaining > 0) {
        const retained = value.subarray(0, remaining);
        chunks.push(retained);
        bytes += retained.length;
      }
      if (value.length > Math.max(remaining, 0)) truncated = true;
    });
    return () => `${Buffer.concat(chunks, bytes).toString('utf8')}${truncated ? `\n[output truncated after ${MAX_CAPTURED_OUTPUT_BYTES} bytes]` : ''}`;
  };
  const getStdout = capture(child.stdout);
  const getStderr = capture(child.stderr);

  let timer;
  let forceTimer;
  let settled = false;
  let timedOut = false;
  const terminate = (signal = 'SIGTERM') => {
    if (settled) return;
    try {
      if (detached && process.platform !== 'win32') {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  const forceKill = () => terminate('SIGKILL');
  const requestTermination = () => {
    if (settled) return;
    terminate('SIGTERM');
    if (!forceTimer) {
      forceTimer = setTimeout(forceKill, TERMINATION_GRACE_MS);
      forceTimer.unref?.();
    }
  };
  const promise = new Promise((resolve, reject) => {
    const onAbort = () => requestTermination();
    const finish = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      spec.signal?.removeEventListener('abort', onAbort);
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(spec.timeout) && spec.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, spec.timeout);
      timer.unref?.();
    }
    child.once('error', (error) => {
      finish();
      reject(error);
    });
    child.once('close', (code, signal) => {
      finish();
      resolve({ stdout: getStdout(), stderr: getStderr(), exitCode: code, signal, timedOut });
    });
  });
  return { promise, cancel: requestTermination, forceKill, child };
}

async function removeTree(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function writeFileAtomic(target, contents) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${makeId('tmp')}`);
  await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    // Android/Linux rename replaces atomically. Windows does not replace an
    // existing file, so use the narrow fallback needed by host-side tests.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') {
      throw error;
    }
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function verifyFile(asset, file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`download is not a regular file: ${asset.url}`);
  if (stat.size !== asset.size) {
    throw new Error(`download size mismatch for ${asset.url}: expected ${asset.size}, got ${stat.size}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) {
    throw new Error(`download checksum mismatch for ${asset.url}`);
  }
  return stat.size;
}

async function downloadWithFetch(fetchImpl, asset, destination) {
  const response = await fetchImpl(asset.url, { redirect: 'follow' });
  if (!response?.ok) {
    throw new Error(`download failed for ${asset.url}: HTTP ${response?.status ?? 'unknown'}`);
  }
  if (response.url && !isAllowedAssetOrigin(response.url)) {
    throw new Error('download redirected away from the official GitHub release origin');
  }
  const hash = createHash('sha256');
  let size = 0;
  const handle = await fs.open(destination, 'wx');
  try {
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > asset.size) throw new Error(`download exceeded declared size for ${asset.url}`);
        hash.update(buffer);
        await handle.write(buffer);
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      size = buffer.length;
      hash.update(buffer);
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
  if (size !== asset.size) {
    throw new Error(`download size mismatch for ${asset.url}: expected ${asset.size}, got ${size}`);
  }
  if (hash.digest('hex') !== asset.sha256) {
    throw new Error(`download checksum mismatch for ${asset.url}`);
  }
}

function cleanHostEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (HOST_ENV_ALLOWLIST.has(key)) environment[key] = value;
  }
  return environment;
}

function isAndroidRuntimeHost() {
  // ANDROID_ROOT is normally injected by Android, while the explicit native
  // library path is supplied by EngineManager. Treat either as the platform
  // marker so a missing system variable cannot select app-private executables.
  return Boolean(process.env.ANDROID_ROOT || process.env.DSH_LINUX_NATIVE_LIBRARY_DIR);
}

function normalizeDnsServers(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  if (value.length > 512) {
    throw linuxRuntimeError('linux-host-dns-unavailable', 'Android DNS server state exceeds its size limit');
  }
  const servers = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  if (servers.some((server) => isIP(server) === 0)) {
    throw linuxRuntimeError('linux-host-dns-unavailable', 'Android supplied an invalid DNS server address');
  }
  return servers.slice(0, 4);
}

function hostDnsServers(environment) {
  if (!isAndroidRuntimeHost()) return normalizeDnsServers(environment.DSH_LINUX_DNS_SERVERS);
  const filesDir = process.env.DSH_FILES_DIR;
  if (typeof filesDir !== 'string' || !path.isAbsolute(filesDir)) {
    throw linuxRuntimeError('linux-host-dns-unavailable', 'Termux app files directory is unavailable for DNS lookup');
  }
  const dnsFile = path.join(path.resolve(filesDir), 'linux-dns-servers');
  let info;
  try {
    info = lstatSync(dnsFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw linuxRuntimeError('linux-host-dns-unavailable', `Android DNS server state could not be read: ${String(error?.message ?? error)}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw linuxRuntimeError('linux-host-dns-unavailable', 'Android DNS server state is not a regular file');
  }
  if (info.size > 512) {
    throw linuxRuntimeError('linux-host-dns-unavailable', 'Android DNS server state exceeds its size limit');
  }
  try {
    return normalizeDnsServers(readFileSync(dnsFile, 'utf8'));
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('linux-')) throw error;
    throw linuxRuntimeError('linux-host-dns-unavailable', `Android DNS server state could not be read: ${String(error?.message ?? error)}`);
  }
}

function linuxRuntimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reportsExpectedProotVersion(result, expectedVersion) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Termux's Android PRoot package prints an ASCII banner ending in the plain
  // four-part version number, while other builds print `PRoot v<version>`.
  // Match a complete version token instead of requiring one banner spelling.
  return new RegExp(`(?:^|[^A-Za-z0-9.])v?${escaped}(?=$|[^A-Za-z0-9.])`, 'i').test(output);
}

function androidNativeFile(name) {
  const directory = process.env.DSH_LINUX_NATIVE_LIBRARY_DIR;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw linuxRuntimeError(
      'linux-host-exec-assets-unavailable',
      `APK native library directory is unavailable for ${name}`,
    );
  }
  const root = path.resolve(directory);
  let rootInfo;
  try { rootInfo = lstatSync(root); } catch { /* reported below */ }
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw linuxRuntimeError('linux-host-exec-assets-unavailable', 'APK native library directory is not a real directory');
  }
  const target = path.join(root, name);
  let info;
  try { info = lstatSync(target); } catch { /* reported below */ }
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
    throw linuxRuntimeError(
      'linux-host-exec-assets-unavailable',
      `APK native PRoot asset is missing or not executable: ${name}`,
    );
  }
  return target;
}

function androidNativeProotLoader() {
  return androidNativeFile(ANDROID_NATIVE_PROOT_LOADER);
}

function androidNativeProot() {
  return androidNativeFile(ANDROID_NATIVE_PROOT);
}

function prootExecutionEnvironment(backend, instanceRoot) {
  const environment = cleanHostEnvironment();
  const nativeLibraryDir = isAndroidRuntimeHost()
    ? path.dirname(androidNativeProot())
    : undefined;
  environment.LD_LIBRARY_PATH = nativeLibraryDir ?? path.join(backend, 'lib');
  environment.PROOT_LOADER = nativeLibraryDir
    ? path.join(nativeLibraryDir, ANDROID_NATIVE_PROOT_LOADER)
    : path.join(backend, 'libexec', 'proot', 'loader');
  environment.PROOT_TMP_DIR = path.join(instanceRoot, 'proot-tmp');
  // PRoot reads this variable by presence. Keep its seccomp compatibility
  // filter available; the observed silent exit 182 is handled at the narrow
  // guest smoke-probe boundary rather than by changing runtime execution mode.
  delete environment.PROOT_NO_SECCOMP;
  return environment;
}

function prootSpawnSpec(proot, args, cwd, env) {
  return { file: proot, args, cwd, env };
}

function prootBind(hostPath, guestPath = hostPath) {
  if (hostPath.includes(':') || guestPath.includes(':')) {
    throw linuxRuntimeError('linux-host-path-unsupported', 'PRoot bind paths cannot contain a colon');
  }
  return `${hostPath}:${guestPath}`;
}

function prootArguments(paths, cwdInfo, resolverFile, guestCommand) {
  const args = [
    '-r', paths.rootfs,
    '-0',
    '-w', cwdInfo.guestCwd,
    '--sysvipc',
    '--kill-on-exit',
  ];
  for (const device of ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']) {
    if (existsSync(device)) args.push('-b', device);
  }
  args.push(
    '-b', prootBind(paths.shm, '/dev/shm'),
    '-b', prootBind(resolverFile, '/etc/resolv.conf'),
    '-b', prootBind(paths.node, paths.node),
  );
  for (const hostPath of cwdInfo.hostPaths) args.push('-b', prootBind(hostPath));

  const inherited = cleanHostEnvironment();
  const guestEnvironment = [
    `HOME=/root`,
    `PATH=${guestPath(paths)}`,
    'TMPDIR=/tmp',
    `LANG=${inherited.LANG ?? 'C.UTF-8'}`,
  ];
  for (const key of GUEST_ENV_ALLOWLIST) {
    if (inherited[key] !== undefined && !['LANG'].includes(key)) guestEnvironment.push(`${key}=${inherited[key]}`);
  }
  args.push('/usr/bin/env', '-i', ...guestEnvironment, ...guestCommand);
  return args;
}

function guestPath(paths) {
  return `${path.join(paths.node, 'bin')}:${DEFAULT_GUEST_PATH}`;
}

function smokeProbeDiagnostics({ result, health, environment, hostCwd }) {
  const limit = value => {
    const text = String(value ?? '');
    return text.length > 4096 ? `${text.slice(0, 4096)} [truncated]` : text;
  };
  const inherited = cleanHostEnvironment();
  const guestEnv = {
    HOME: '/root',
    PATH: guestPath(health.paths),
    TMPDIR: '/tmp',
    LANG: inherited.LANG ?? 'C.UTF-8',
    forwardedVariableNames: GUEST_ENV_ALLOWLIST.filter(key => key !== 'LANG' && inherited[key] !== undefined),
  };
  const prootEnv = {
    LD_LIBRARY_PATH: environment.LD_LIBRARY_PATH,
    PROOT_LOADER: environment.PROOT_LOADER,
    PROOT_TMP_DIR: environment.PROOT_TMP_DIR,
    PROOT_NO_SECCOMP: environment.PROOT_NO_SECCOMP ?? null,
  };
  return [
    `hostCwd=${JSON.stringify(hostCwd)}`,
    'guestCwd="/"',
    'guestCommand=["/bin/bash","-c","node --version"]',
    `env=${JSON.stringify({ guest: guestEnv, proot: prootEnv })}`,
    `stdout=${JSON.stringify(limit(result.stdout))}`,
    `stderr=${JSON.stringify(limit(result.stderr))}`,
  ].join('; ');
}

function executableFileExists(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function measureUnpackedBytes(directory) {
  let total = 0;
  const seen = new Set();
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          total += stat.size;
        }
      }
    }
  }
  await visit(directory);
  return total;
}

export class LinuxRuntimeManager {
  constructor(options = {}) {
    if (!options.dataDir) throw new TypeError('dataDir is required');
    if (options.arch !== undefined && options.arch !== 'arm64' && options.arch !== 'x64') {
      throw new TypeError('arch must be arm64 or x64');
    }
    this.dataDir = assertSafeDataDir(options.dataDir);
    if (options.allowedHostPaths !== undefined && !Array.isArray(options.allowedHostPaths)) {
      throw new TypeError('allowedHostPaths must be an array of absolute directories');
    }
    this.allowedHostPaths = (options.allowedHostPaths ?? []).map((entry, index) => {
      if (typeof entry !== 'string' || !path.isAbsolute(entry) || entry.includes('\0')) {
        throw new TypeError(`allowedHostPaths[${index}] must be an absolute path`);
      }
      return path.resolve(entry);
    });
    this.arch = options.arch ?? 'arm64';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.downloadAsset = options.downloadAsset;
    this.extractArchive = options.extractArchive;
    this.runCommand = options.runCommand ?? spawnCommand;
    if (typeof this.runCommand !== 'function') throw new TypeError('runCommand must be a function');
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : undefined;
    this.events = new EventEmitter();
    this.children = new Set();
    this.pendingExecutions = new Set();
    this.gate = new ExecutionGate();
    this.disposed = false;
  }

  on(event, listener) {
    this.events.on(event, listener);
    return this;
  }

  off(event, listener) {
    this.events.off(event, listener);
    return this;
  }

  _paths() {
    return {
      active: path.join(this.dataDir, 'active.json'),
      instances: path.join(this.dataDir, 'instances'),
      sharedNode: path.join(this.dataDir, 'shared', 'node'),
      staging: path.join(this.dataDir, '.staging'),
      deleting: path.join(this.dataDir, '.deleting'),
    };
  }

  _instancePaths(instanceId) {
    assertSafeId(instanceId, 'instanceId');
    const root = path.join(this._paths().instances, instanceId);
    if (!pathIsWithin(this.dataDir, root)) throw new Error('instance path escaped dataDir');
    return {
      root,
      backend: path.join(root, 'backend'),
      rootfs: path.join(root, 'rootfs'),
      metadata: path.join(root, 'metadata.json'),
    };
  }

  _nodePath(nodeKey) {
    assertSafeId(nodeKey, 'nodeKey');
    return path.join(this._paths().sharedNode, nodeKey, this.arch);
  }

  /**
   * Content-addressed root of a shared Node installation.
   *
   * Cleanup removes this directory, not just the architecture leaf, so an
   * uninstall does not leave an empty `<nodeKey>/` husk behind.
   */
  _nodeRoot(nodeKey) {
    assertSafeId(nodeKey, 'nodeKey');
    return path.join(this._paths().sharedNode, nodeKey);
  }

  _readActive() {
    const file = this._paths().active;
    if (!fileExists(file)) return undefined;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObject(value) || value.schemaVersion !== ACTIVE_SCHEMA_VERSION) return undefined;
      assertSafeId(value.instanceId, 'active.instanceId');
      assertSafeId(value.runtimeId, 'active.runtimeId');
      if (value.architecture !== this.arch || typeof value.version !== 'string') return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  _healthForRecord(record) {
    if (!record) return { healthy: false, reason: 'runtime is not installed' };
    let instance;
    try {
      instance = this._instancePaths(record.instanceId);
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
    const nodeKey = record.nodeKey ?? record.nodeVersion;
    if (typeof nodeKey !== 'string') return { healthy: false, reason: 'active record has no shared Node identity' };
    let node;
    try {
      node = this._nodePath(nodeKey);
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
    const bundledProot = path.join(instance.backend, 'bin', 'proot');
    let proot = bundledProot;
    const bundledLoader = path.join(instance.backend, 'libexec', 'proot', 'loader');
    let loader = bundledLoader;
    if (isAndroidRuntimeHost()) {
      try {
        proot = androidNativeProot();
        loader = androidNativeProotLoader();
        androidNativeFile(ANDROID_NATIVE_TALLOC);
        androidNativeFile(ANDROID_NATIVE_SHMEM);
      }
      catch (error) { return { healthy: false, reason: error.message }; }
    }
    const required = [
      ['bundled PRoot executable', bundledProot, true],
      ['bundled PRoot loader', bundledLoader, true],
      ['PRoot dependency library directory', path.join(instance.backend, 'lib'), false],
      ['shared Linux Node', path.join(node, 'bin', 'node'), true],
      ['shared npm directory', path.join(node, 'lib', 'node_modules', 'npm'), false],
    ];
    for (const [label, file, executable] of required) {
      if ((executable ? !executableFileExists(file) : !fileExists(file) && !directoryExists(file))) {
        return { healthy: false, reason: `${label} is missing or not executable` };
      }
    }
    for (const relative of ROOTFS_REQUIRED_FILES) {
      const target = path.join(instance.rootfs, relative);
      if (!fileExists(target) && !directoryExists(target)) {
        return { healthy: false, reason: `rootfs file is missing: /${relative}` };
      }
    }
    const compatLibrary = path.join(instance.rootfs, ROOTFS_COMPAT_LIBRARY);
    const preloadFile = path.join(instance.rootfs, ROOTFS_PRELOAD_FILE);
    try {
      const compatInfo = lstatSync(compatLibrary);
      if (!compatInfo.isFile() || compatInfo.isSymbolicLink() || (compatInfo.mode & 0o111) === 0) {
        return { healthy: false, reason: 'PRoot hard-link compatibility library is missing or unsafe' };
      }
      if (!readFileSync(preloadFile, 'utf8').split(/\r?\n/).includes('/opt/pocket-harness/libpocket-linux-compat.so')) {
        return { healthy: false, reason: 'rootfs does not register the PRoot compatibility library' };
      }
    } catch {
      return { healthy: false, reason: 'rootfs PRoot compatibility preload is incomplete' };
    }
    if (!directoryExists(instance.root) || !directoryExists(instance.backend) || !directoryExists(instance.rootfs)) {
      return { healthy: false, reason: 'runtime instance is incomplete' };
    }
    return {
      healthy: true,
      paths: {
        instance: instance.root,
        backend: instance.backend,
        rootfs: instance.rootfs,
        node,
        proot,
        loader,
        shm: path.join(instance.root, 'dev-shm'),
        prootTmp: path.join(instance.root, 'proot-tmp'),
      },
    };
  }

  async _probeRuntime(health, expectedProotVersion) {
    await fs.mkdir(health.paths.shm, { recursive: true });
    await fs.mkdir(health.paths.prootTmp, { recursive: true });
    const environment = prootExecutionEnvironment(health.paths.backend, health.paths.instance);
    const versionSpec = prootSpawnSpec(
      health.paths.proot,
      ['--version'],
      this.dataDir,
      environment,
    );
    versionSpec.timeout = 10_000;
    const version = normaliseCommandResult(await this._runManaged(versionSpec));
    if (version.timedOut || version.exitCode !== 0 || !reportsExpectedProotVersion(version, expectedProotVersion)) {
      const reason = version.timedOut
        ? 'timed out'
        : version.exitCode !== 0
          ? `exit ${version.exitCode ?? 'unknown'}`
          : `did not report expected version ${expectedProotVersion}`;
      throw new Error(`PRoot launcher probe failed (${reason}): ${(version.stderr || version.stdout).trim().slice(0, 500)}`);
    }

    const resolverFile = await this._writeResolverFile(health.paths.instance);
    try {
      const cwdInfo = { guestCwd: '/', hostPaths: [] };
      const args = prootArguments(health.paths, cwdInfo, resolverFile, ['/bin/bash', '-c', 'node --version']);
      const probeSpec = prootSpawnSpec(
        health.paths.proot,
        args,
        this.dataDir,
        environment,
      );
      probeSpec.timeout = 10_000;
      let result;
      let attempts = 0;
      do {
        attempts += 1;
        result = normaliseCommandResult(await this._runManaged(probeSpec));
        if (
          result.timedOut ||
          result.exitCode !== 182 ||
          result.stdout !== '' ||
          result.stderr !== ''
        ) break;
      } while (attempts < MAX_GUEST_SMOKE_PROBE_ATTEMPTS);

      if (result.timedOut || result.exitCode !== 0 || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(result.stdout.trim())) {
        const reason = result.timedOut
          ? 'PRoot guest smoke probe timed out'
          : `PRoot guest smoke probe failed (exit ${result.exitCode ?? 'unknown'}${attempts > 1 ? ` after ${attempts} attempts` : ''})`;
        const diagnostics = smokeProbeDiagnostics({ result, health, environment, hostCwd: this.dataDir });
        throw new Error(`${reason}; ${diagnostics}`);
      }
    } finally {
      await fs.rm(resolverFile, { force: true });
    }
  }

  status() {
    if (this.disposed) {
      return Object.freeze({ healthy: false, installed: false, state: 'disposed', reason: 'manager is disposed' });
    }
    const activeFile = this._paths().active;
    if (!fileExists(activeFile)) {
      return Object.freeze({ healthy: false, installed: false, state: 'absent', reason: 'runtime is not installed' });
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(activeFile, 'utf8'));
    } catch (error) {
      return Object.freeze({ healthy: false, installed: false, state: 'unhealthy', reason: `active.json is unreadable: ${error.message}` });
    }
    if (!isObject(raw) || raw.schemaVersion !== ACTIVE_SCHEMA_VERSION) {
      return Object.freeze({ healthy: false, installed: false, state: 'unhealthy', reason: 'active.json has an unsupported schema' });
    }
    const health = this._healthForRecord(raw);
    return Object.freeze({
      healthy: health.healthy,
      installed: true,
      state: health.healthy ? 'healthy' : 'unhealthy',
      reason: health.reason,
      runtimeId: raw.runtimeId,
      version: raw.version,
      architecture: raw.architecture,
      instanceId: raw.instanceId,
      paths: health.paths,
    });
  }

  _emitState() {
    const state = Object.freeze({ ...this.status(), ...(this.lastCleanupError ? { cleanupWarning: this.lastCleanupError } : {}) });
    for (const listener of this.events.rawListeners('change')) {
      try { listener.call(this.events, state); } catch { /* Observers cannot undo a committed installation. */ }
    }
    try {
      this.onStateChange?.(state);
    } catch {
      // State observers cannot break installation or execution.
    }
    return state;
  }

  /**
   * Management critical section: install, reinstall, uninstall and dispose.
   *
   * In-flight guest commands are aborted first so a cutover cannot race a
   * process still reading the rootfs being replaced, and any command issued
   * after this point waits until the critical section ends.
   */
  async _exclusive(operation) {
    if (this.gate.busy) await this._stopChildren();
    await this.gate.acquireExclusive();
    try {
      return await operation();
    } finally {
      this.gate.releaseExclusive();
    }
  }

  async _ensureDirectories() {
    const paths = this._paths();
    await fs.mkdir(paths.instances, { recursive: true });
    await fs.mkdir(paths.sharedNode, { recursive: true });
    await fs.mkdir(paths.staging, { recursive: true });
    await fs.mkdir(paths.deleting, { recursive: true });
  }

  async _download(asset, destination) {
    assertOfficialAssetUrl(asset.url);
    if (typeof this.downloadAsset === 'function') {
      await this.downloadAsset(asset, destination);
      await verifyFile(asset, destination);
      return;
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('downloadAsset IO is required; no fetchImpl is available');
    }
    await downloadWithFetch(this.fetchImpl, asset, destination);
  }

  async _extract(archive, destination, kind) {
    if (typeof this.extractArchive !== 'function') {
      throw new Error('extractArchive IO is required; refusing unsafe shell extraction');
    }
    await fs.mkdir(destination, { recursive: true });
    await this.extractArchive(archive, destination, { kind });
  }

  async _materialize(asset, archive, destination, kind) {
    await this._download(asset, archive);
    await this._extract(archive, destination, kind);
  }

  async _runManaged(spec) {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(spec.signal?.reason);
    if (spec.signal?.aborted) relayAbort();
    else spec.signal?.addEventListener('abort', relayAbort, { once: true });
    const effectiveSpec = { ...spec, signal: controller.signal };
    let raw;
    try {
      raw = this.runCommand(effectiveSpec);
    } catch (error) {
      spec.signal?.removeEventListener('abort', relayAbort);
      throw error;
    }
    const handle = normaliseRunnerResult(raw);
    const child = {
      abort: () => controller.abort(new Error('Linux runtime operation stopped')),
      cancel: handle.cancel,
      forceKill: handle.forceKill,
      promise: handle.promise,
    };
    this.children.add(child);
    try {
      return await handle.promise;
    } finally {
      this.children.delete(child);
      spec.signal?.removeEventListener('abort', relayAbort);
    }
  }

  async _stopChildren() {
    for (const controller of this.pendingExecutions) {
      try { controller.abort(new Error('Linux runtime operation stopped')); } catch { /* Continue stopping pending work. */ }
    }
    const children = [...this.children];
    for (const child of children) {
      try {
        child.abort();
      } catch {
        // Continue terminating all children.
      }
      try {
        child.cancel?.('SIGTERM');
      } catch {
        // Continue terminating all children.
      }
    }
    if (children.length > 0) {
      await Promise.race([
        Promise.allSettled(children.map((child) => child.promise)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    for (const child of children) {
      try {
        child.forceKill?.();
      } catch {
        // Best effort after the grace period.
      }
    }
  }

  async _prepareRootfs(instance) {
    try {
      for (const relative of ['dev', 'proc', 'sys', 'tmp', 'var/tmp', 'etc']) {
        if (!directoryExists(path.join(instance.rootfs, relative))) {
          throw new Error(`rootfs directory is missing: /${relative}`);
        }
      }
      // Debian's base rootfs intentionally omits /dev/shm; it is normally
      // created by init. PRoot binds the app-private shm directory there, so
      // provide the guest-side target before the bind rather than requiring it
      // to be present in the offline rootfs archive.
      const shmMountPoint = path.join(instance.rootfs, 'dev/shm');
      if (!directoryExists(shmMountPoint)) await fs.mkdir(shmMountPoint, { recursive: true });
      if (!directoryExists(shmMountPoint)) throw new Error('rootfs directory is missing: /dev/shm');
      for (const relative of ['etc/resolv.conf', ROOTFS_PRELOAD_FILE, ROOTFS_COMPAT_LIBRARY]) {
        const file = path.join(instance.rootfs, relative);
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe rootfs file: /${relative}`);
      }
      const compat = lstatSync(path.join(instance.rootfs, ROOTFS_COMPAT_LIBRARY));
      if ((compat.mode & 0o111) === 0) throw new Error('PRoot compatibility preload is not executable');
      const registered = readFileSync(path.join(instance.rootfs, ROOTFS_PRELOAD_FILE), 'utf8')
        .split(/\r?\n/).includes('/opt/pocket-harness/libpocket-linux-compat.so');
      if (!registered) throw new Error('rootfs does not register the PRoot compatibility preload');
    } catch (error) {
      throw linuxRuntimeError('linux-rootfs-prepare-failed', String(error?.message ?? error));
    }
  }

  async _writeResolverFile(instanceRoot) {
    const servers = hostDnsServers(cleanHostEnvironment());
    const directory = path.join(instanceRoot, 'proot-network');
    await fs.mkdir(directory, { recursive: true });
    const resolver = path.join(directory, `${makeId('resolver')}.conf`);
    const lines = servers.length > 0
      ? ['# Resolvers supplied by the current Android network.', ...servers.map((server) => `nameserver ${server}`)]
      : ['# No safe DNS resolver is available on the current Android network.'];
    await fs.writeFile(resolver, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    return resolver;
  }

  async _ensureSharedNode(runtime, staging, activeRecord) {
    const node = this._nodePath(nodeKeyFor(runtime));
    if (this._nodeIsHealthy(node)) return { node, created: false };
    const hadBrokenNode = existsSync(node);
    if (hadBrokenNode && activeRecord) await this._stopChildren();
    if (hadBrokenNode) await removeTree(node);
    const nodeStage = path.join(staging, 'node');
    const archive = path.join(staging, 'node.archive');
    await this._materialize(runtime.nodeAsset, archive, nodeStage, 'node');
    if (!this._nodeIsHealthy(nodeStage)) {
      throw new Error('shared Linux Node archive is incomplete');
    }
    await fs.mkdir(path.dirname(node), { recursive: true });
    await fs.rename(nodeStage, node);
    return { node, created: true };
  }

  _nodeIsHealthy(node) {
    return fileExists(path.join(node, 'bin', 'node')) && directoryExists(path.join(node, 'lib', 'node_modules', 'npm'));
  }

  async _writeActive(record) {
    await writeFileAtomic(this._paths().active, `${JSON.stringify(record, null, 2)}\n`);
  }

  async _removeActive() {
    const active = this._paths().active;
    if (!fileExists(active)) return;
    const tombstone = path.join(this._paths().deleting, `${makeId('active')}.json`);
    await fs.rename(active, tombstone);
    await fs.rm(tombstone, { force: true });
  }

  async _removePreviousInstance(record, keepNodeKey) {
    if (!record?.instanceId) return;
    const instance = this._instancePaths(record.instanceId).root;
    if (!pathIsWithin(this.dataDir, instance)) return;
    await removeTree(instance);
    const previousNodeKey = record.nodeKey ?? record.nodeVersion;
    if (previousNodeKey && previousNodeKey !== keepNodeKey) {
      const node = this._nodePath(previousNodeKey);
      if (!this._nodeReferencedByAnyInstance(node)) await removeTree(this._nodeRoot(previousNodeKey));
    }
  }

  _nodeReferencedByAnyInstance(node) {
    const instances = this._paths().instances;
    if (!directoryExists(instances)) return false;
    let entries;
    try {
      entries = requireDirectoryEntries(instances);
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = path.join(instances, entry.name, 'metadata.json');
      try {
        const value = JSON.parse(readFileSync(metadata, 'utf8'));
        const key = value.nodeKey ?? value.nodeVersion;
        if (key && path.resolve(this._nodePath(key)) === path.resolve(node)) return true;
      } catch {
        // An unknown instance is preserved conservatively.
        return true;
      }
    }
    return false;
  }

  /**
   * Install (or replace) the active runtime instance.
   *
   * The whole swap runs under the management gate: the rootfs, backend and
   * shared Node are staged first, health is proven on the staged tree, and only
   * then is the active record atomically replaced. A failure leaves the
   * previously active instance untouched.
   */
  async install(manifest, runtimeId = 'debian-minimal') {
    return this._exclusive(() => this._installLocked(manifest, runtimeId));
  }

  async _installLocked(manifest, runtimeId) {
    if (this.disposed) throw new Error('manager is disposed');
    const selection = selectRuntime(manifest, runtimeId, this.arch);
    if (isAndroidRuntimeHost()) {
      this._assertAndroidNativeProotLoader();
      await this._probeAndroidNativeProot(selection.runtime.prootVersion);
    }
    await this._ensureDirectories();
    const previous = this._readActive();
    const instanceId = makeId(runtimeId);
    const staging = path.join(this._paths().staging, instanceId);
    const stagedInstance = path.join(staging, 'instance');
    const finalInstance = this._instancePaths(instanceId).root;
    let nodeCreated = false;
    let finalPublished = false;
    let committedRecord;
    const nodeKey = nodeKeyFor(selection.runtime);
    try {
      await fs.mkdir(stagedInstance, { recursive: true });
      const instance = {
        root: stagedInstance,
        backend: path.join(stagedInstance, 'backend'),
        rootfs: path.join(stagedInstance, 'rootfs'),
      };
      const nodeResult = await this._ensureSharedNode(selection.runtime, staging, previous);
      nodeCreated = nodeResult.created;
      await this._materialize(
        selection.runtime.backendAsset,
        path.join(staging, 'backend.archive'),
        instance.backend,
        'backend',
      );
      await this._materialize(
        selection.runtime.rootfsAsset,
        path.join(staging, 'rootfs.archive'),
        instance.rootfs,
        'rootfs',
      );
      await this._prepareRootfs(instance);
      const record = {
        schemaVersion: ACTIVE_SCHEMA_VERSION,
        instanceId,
        runtimeId: selection.runtime.id,
        version: selection.manifest.version,
        architecture: selection.runtime.architecture,
        nodeKey,
        activatedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(stagedInstance, 'metadata.json'),
        `${JSON.stringify({ ...record, schemaVersion: METADATA_SCHEMA_VERSION }, null, 2)}\n`,
        { flag: 'wx' },
      );
      await fs.rename(stagedInstance, finalInstance);
      finalPublished = true;
      const health = this._healthForRecord(record);
      if (!health.healthy) throw new Error(`staged runtime is unhealthy: ${health.reason}`);
      await this._probeRuntime(health, selection.runtime.prootVersion);
      await this._stopChildren();
      await this._writeActive(record);
      committedRecord = record;
    } catch (error) {
      if (finalPublished) await removeTree(finalInstance).catch(() => undefined);
      if (nodeCreated && !this._nodeReferencedByAnyInstance(this._nodePath(nodeKey))) {
        await removeTree(this._nodeRoot(nodeKey)).catch(() => undefined);
      }
      throw error;
    } finally {
      await removeTree(staging).catch(() => undefined);
    }
    // The active pointer is committed. Garbage collection must never roll it back.
    this.lastCleanupError = null;
    if (previous && previous.instanceId !== committedRecord.instanceId) {
      try { await this._removePreviousInstance(previous, nodeKey); }
      catch (error) { this.lastCleanupError = String(error?.message ?? error); }
    }
    return this._emitState();
  }

  _assertAndroidNativeProotLoader() {
    try {
      androidNativeProot();
      androidNativeProotLoader();
      androidNativeFile(ANDROID_NATIVE_TALLOC);
      androidNativeFile(ANDROID_NATIVE_SHMEM);
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('linux-')) throw error;
      throw linuxRuntimeError(
        'linux-host-exec-assets-unavailable',
        `APK native PRoot loader could not be inspected: ${String(error?.message ?? error)}`,
      );
    }
  }

  async _probeAndroidNativeProot(expectedProotVersion) {
    const proot = androidNativeProot();
    const spec = prootSpawnSpec(
      proot,
      ['--version'],
      this.dataDir,
      prootExecutionEnvironment('', this.dataDir),
    );
    spec.timeout = 5000;
    let result;
    try {
      result = normaliseCommandResult(await this._runManaged(spec));
    } catch (error) {
      throw linuxRuntimeError(
        'linux-host-exec-assets-unavailable',
        `APK native PRoot probe failed: ${String(error?.message ?? error)}`,
      );
    }
    if (result.timedOut || result.exitCode !== 0 || !reportsExpectedProotVersion(result, expectedProotVersion)) {
      const reason = result.timedOut
        ? 'timed out'
        : result.exitCode !== 0
          ? `exit ${result.exitCode ?? 'unknown'}`
          : `did not report expected version ${expectedProotVersion}`;
      throw linuxRuntimeError(
        'linux-host-exec-assets-unavailable',
        `APK native PRoot probe failed (${reason}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
      );
    }
  }

  async reinstall(manifest, runtimeId = 'debian-minimal') {
    return this.install(manifest, runtimeId);
  }

  async uninstall() {
    return this._exclusive(async () => {
      // Bootstrap may retain the handle after scope teardown solely to remove its data.
      // Disposal still prevents new execution/installation, but must not turn uninstall into a no-op.
      const previous = this._readActive();
      if (!previous) {
        await this._removeActive().catch(() => undefined);
        return this._emitState();
      }
      await this._stopChildren();
      const instance = this._instancePaths(previous.instanceId).root;
      const tombstone = path.join(this._paths().deleting, `${previous.instanceId}-${makeId('delete')}`);
      if (directoryExists(instance)) await fs.rename(instance, tombstone);
      await this._removeActive();
      await removeTree(tombstone);
      const previousNodeKey = previous.nodeKey ?? previous.nodeVersion;
      if (previousNodeKey && !this._nodeReferencedByAnyInstance(this._nodePath(previousNodeKey))) {
        await removeTree(this._nodeRoot(previousNodeKey));
      }
      return this._emitState();
    });
  }

  _resolveCwd(cwd, rootfs) {
    if (cwd == null || cwd === '') return { guestCwd: '/', hostPaths: [] };
    // "Absolute" is platform-aware on purpose: on Android this is the POSIX
    // check, while host-side tests can pass a real Windows temp directory.
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new TypeError('cwd must be an absolute path');
    }
    const resolved = path.resolve(cwd);
    if (pathIsWithin(rootfs, resolved)) {
      const relative = path.relative(rootfs, resolved).split(path.sep).filter(Boolean).join('/');
      return { guestCwd: relative ? `/${relative}` : '/', hostPaths: [] };
    }
    if (isGuestPath(cwd) || !existsSync(cwd)) {
      // A guest-namespace directory is never promoted to a host pass-through:
      // the launcher resolves a configured host directory before the rootfs, so
      // promoting /tmp or /etc would shadow the guest's own subtree. A path that
      // does not exist on the host is likewise only meaningful inside the guest.
      return { guestCwd: cwd, hostPaths: [] };
    }
    let realCwd;
    try {
      realCwd = realpathSync(resolved);
      if (!statSync(realCwd).isDirectory()) throw new TypeError('cwd must be a directory');
    } catch (error) {
      throw linuxRuntimeError('linux-host-path-invalid', `Host cwd is not a readable directory: ${String(error.message ?? error)}`);
    }
    if (!this._isAllowedHostPath(realCwd)) {
      throw linuxRuntimeError('linux-host-path-not-allowed', 'Host cwd is outside the configured Linux workspace and shared directories');
    }
    return { guestCwd: realCwd, hostPaths: [realCwd] };
  }

  _isAllowedHostPath(realCandidate) {
    return this.allowedHostPaths.some((root) => {
      try {
        return pathIsWithin(realpathSync(root), realCandidate);
      } catch {
        return false;
      }
    });
  }

  async execute({ command, cwd, timeout, signal } = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('command must be a non-empty string');
    }
    await this.gate.acquireShared();
    const execution = new AbortController();
    const relayAbort = () => execution.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    this.pendingExecutions.add(execution);
    try {
      if (this.disposed) throw new Error('manager is disposed');
      if (execution.signal.aborted) {
        return { stdout: '', stderr: 'aborted', exitCode: 130, signal: null, timedOut: false, cwd: cwd ?? '/', runtimeId: undefined, architecture: this.arch };
      }
      const current = this.status();
      if (!current.healthy) {
        throw new Error(`Linux runtime is unavailable: ${current.reason ?? 'unhealthy'}`);
      }
      const cwdInfo = this._resolveCwd(cwd, current.paths.rootfs);
      await fs.mkdir(current.paths.shm, { recursive: true });
      await fs.mkdir(current.paths.prootTmp, { recursive: true });
      if (execution.signal.aborted) {
        return { stdout: '', stderr: 'aborted', exitCode: 130, signal: null, timedOut: false, cwd: cwdInfo.guestCwd, runtimeId: current.runtimeId, architecture: current.architecture };
      }
      const resolverFile = await this._writeResolverFile(current.paths.instance);
      try {
        if (execution.signal.aborted) {
          return { stdout: '', stderr: 'aborted', exitCode: 130, signal: null, timedOut: false, cwd: cwdInfo.guestCwd, runtimeId: current.runtimeId, architecture: current.architecture };
        }
        const environment = prootExecutionEnvironment(current.paths.backend, current.paths.instance);
        const args = prootArguments(current.paths, cwdInfo, resolverFile, ['/bin/bash', '-c', command]);
        const spec = prootSpawnSpec(current.paths.proot, args, this.dataDir, environment);
        spec.timeout = timeout;
        spec.signal = execution.signal;
        const result = normaliseCommandResult(await this._runManaged(spec));
        return {
          ...result,
          cwd: cwdInfo.guestCwd,
          runtimeId: current.runtimeId,
          architecture: current.architecture,
        };
      } finally {
        await fs.rm(resolverFile, { force: true });
      }
    } finally {
      this.pendingExecutions.delete(execution);
      signal?.removeEventListener('abort', relayAbort);
      this.gate.releaseShared();
    }
  }

  async dispose() {
    return this._exclusive(async () => {
      if (this.disposed) return;
      await this._stopChildren();
      this.disposed = true;
      this._emitState();
      this.events.removeAllListeners();
    });
  }
}

/**
 * Content-addressed identity of the shared Linux Node package.
 *
 * Keying by the archive digest means an unrelated Linux system release that
 * ships the same Node archive reuses the existing installation instead of
 * downloading and installing Node again.
 */
function nodeKeyFor(runtime) {
  const sha256 = runtime?.nodeAsset?.sha256;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError('runtime.nodeAsset.sha256 is required for the shared Linux Node');
  }
  return `sha256-${sha256}`;
}

function requireDirectoryEntries(directory) {
  // The synchronous form keeps status/uninstall fail-closed without making
  // status() unexpectedly asynchronous.
  return readdirSync(directory, { withFileTypes: true });
}

export function createManager(options) {
  return new LinuxRuntimeManager(options);
}
