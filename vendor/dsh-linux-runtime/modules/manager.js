import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, createReadStream, existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  'BIONILUX_DNS_SERVERS',
]);
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const TERMINATION_GRACE_MS = 1500;
const HOST_TOOL_PROBE_TIMEOUT_MS = 5000;
const ANDROID_NATIVE_LAUNCHER = 'libpocketharness_bionilux.so';
const ANDROID_NATIVE_GLIBC_LOADER = 'libpocketharness_glibc_loader.so';
const GNU_HOST_TOOLS = Object.freeze({
  find: /^(?:\S*\/)?find \(GNU findutils\) /m,
  sed: /^(?:\S*\/)?sed \(GNU sed\) /m,
  wc: /^(?:\S*\/)?wc \(GNU coreutils\) /m,
});
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
  if (!process.env.ANDROID_ROOT) return normalizeDnsServers(environment.BIONILUX_DNS_SERVERS);
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

function resolveHostLibraryPath(configuredPath) {
  const filesDir = process.env.DSH_FILES_DIR;
  const prefix = process.env.TERMUX__PREFIX ?? process.env.PREFIX;
  const candidate = configuredPath ?? (filesDir ? path.join(filesDir, 'usr', 'lib') : prefix ? path.join(prefix, 'lib') : undefined);
  if (!candidate) {
    if (process.env.ANDROID_ROOT) {
      throw linuxRuntimeError('linux-host-library-path-unavailable', 'Termux host library directory is not configured');
    }
    return undefined;
  }
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw linuxRuntimeError('linux-host-library-path-unavailable', 'Termux host library directory must be an absolute path');
  }
  const resolved = path.resolve(candidate);
  if (!directoryExists(resolved)) {
    throw linuxRuntimeError('linux-host-library-path-unavailable', 'Termux host library directory is unavailable');
  }
  return resolved;
}

function androidNativeRuntimeEntrypoints() {
  const directory = process.env.DSH_LINUX_NATIVE_LIBRARY_DIR;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw linuxRuntimeError(
      'linux-host-exec-assets-unavailable',
      'APK native library directory is unavailable for the Linux launcher and glibc loader',
    );
  }
  const root = path.resolve(directory);
  let rootInfo;
  try { rootInfo = lstatSync(root); } catch { /* reported below */ }
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw linuxRuntimeError('linux-host-exec-assets-unavailable', 'APK native library directory is not a real directory');
  }
  const files = {};
  for (const [key, name] of [['launcher', ANDROID_NATIVE_LAUNCHER], ['loader', ANDROID_NATIVE_GLIBC_LOADER]]) {
    const target = path.join(root, name);
    let info;
    try { info = lstatSync(target); } catch { /* reported below */ }
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
      throw linuxRuntimeError(
        'linux-host-exec-assets-unavailable',
        `APK native Linux executable is missing or not executable: ${name}`,
      );
    }
    files[key] = target;
  }
  return files;
}

function baseExecutionEnvironment(configuredLibraryPath) {
  const environment = cleanHostEnvironment();
  const dnsServers = hostDnsServers(environment);
  if (dnsServers.length > 0) environment.BIONILUX_DNS_SERVERS = dnsServers.join(',');
  else if (process.env.ANDROID_ROOT) environment.BIONILUX_DNS_SERVERS = 'none';
  else delete environment.BIONILUX_DNS_SERVERS;
  const hostLibraryPath = resolveHostLibraryPath(configuredLibraryPath);
  if (hostLibraryPath) environment.LD_LIBRARY_PATH = hostLibraryPath;
  return { environment, hostLibraryPath };
}

function hostExecutionEnvironment(configuredLibraryPath) {
  const { environment, hostLibraryPath } = baseExecutionEnvironment(configuredLibraryPath);

  if (process.env.ANDROID_ROOT) {
    const filesDir = process.env.DSH_FILES_DIR;
    if (typeof filesDir !== 'string' || !path.isAbsolute(filesDir)) {
      throw linuxRuntimeError(
        'linux-termux-exec-environment-unavailable',
        'Termux app files directory is missing or not an absolute path',
      );
    }
    const appFilesDir = path.resolve(filesDir);
    const prefix = path.join(appFilesDir, 'usr');
    const libraryDirectory = path.join(prefix, 'lib');
    const preload = path.join(libraryDirectory, 'libtermux-exec-ld-preload.so');
    let preloadIsRegularFile = false;
    try { preloadIsRegularFile = lstatSync(preload).isFile(); } catch { /* checked below */ }
    if (!directoryExists(prefix) || !directoryExists(libraryDirectory) || !preloadIsRegularFile) {
      throw linuxRuntimeError(
        'linux-termux-exec-environment-unavailable',
        `Termux exec shim is unavailable under the app prefix (${preload})`,
      );
    }
    if (hostLibraryPath !== libraryDirectory) {
      throw linuxRuntimeError(
        'linux-host-library-path-unavailable',
        'Termux host library directory does not match DSH_FILES_DIR/usr/lib',
      );
    }

    // Derive these values from the in-app snapshot. Never trust inherited values:
    // they control termux-exec's execve rewrite and the shell's /usr/bin mapping.
    environment.PATH = `${path.join(prefix, 'bin')}${path.delimiter}/system/bin`;
    environment.LD_LIBRARY_PATH = libraryDirectory;
    environment.LD_PRELOAD = preload;
    environment.TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE = 'force';
    environment.TERMUX_EXEC__EXECVE_CALL__INTERCEPT = '1';
    environment.TERMUX__ROOTFS = appFilesDir;
    environment.TERMUX__PREFIX = prefix;
    environment.TERMUX_APP__DATA_DIR = path.dirname(appFilesDir);
  }

  return environment;
}

function bioniluxExecutionEnvironment(configuredLibraryPath) {
  const { environment } = baseExecutionEnvironment(configuredLibraryPath);
  if (process.env.ANDROID_ROOT) {
    const nativeRuntime = androidNativeRuntimeEntrypoints();
    environment.BIONILUX_LOADER = nativeRuntime.loader;
    // Spawn the package-installed Bionic launcher directly. If termux-exec
    // rewrites this spawn through linker64, /proc/self/exe becomes linker64;
    // Bionilux then records the wrong re-entry path for guest exec children.
    delete environment.LD_LIBRARY_PATH;
  }
  return environment;
}

function nativeLauncherProbePassed(result) {
  return !result.timedOut && result.exitCode === 0 && /(?:^|\n)BIONILUX_VERSION=\S+/m.test(result.stdout);
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
    this.arch = options.arch ?? 'arm64';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.downloadAsset = options.downloadAsset;
    this.extractArchive = options.extractArchive;
    this.runCommand = options.runCommand ?? spawnCommand;
    if (typeof this.runCommand !== 'function') throw new TypeError('runCommand must be a function');
    this.hostLibraryPath = options.hostLibraryPath;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : undefined;
    this.events = new EventEmitter();
    this.children = new Set();
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
    let launcher = path.join(instance.backend, 'bin', 'bionilux');
    if (process.env.ANDROID_ROOT) {
      try { launcher = androidNativeRuntimeEntrypoints().launcher; }
      catch (error) { return { healthy: false, reason: error.message }; }
    }
    const required = [
      ['backend executable', path.join(instance.backend, 'bin', 'bionilux'), true],
      ['backend preload', path.join(instance.backend, 'lib', 'libbionilux_preload.so'), false],
      ['rootfs preparation script', path.join(instance.backend, 'scripts', 'prepare-rootfs.sh'), false],
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
        launcher,
        preload: path.join(instance.backend, 'lib', 'libbionilux_preload.so'),
      },
    };
  }

  async _probeRuntime(health) {
    const nodeBin = path.join(health.paths.node, 'bin');
    const hostEnvironment = bioniluxExecutionEnvironment(this.hostLibraryPath);
    const result = normaliseCommandResult(await this._runManaged({
      file: health.paths.launcher,
      args: ['node', '--version'],
      cwd: this.dataDir,
      env: {
        ...hostEnvironment,
        BIONILUX_ROOTFS: health.paths.rootfs,
        BIONILUX_PRELOAD: health.paths.preload,
        BIONILUX_GUEST_CWD: '/',
        BIONILUX_GUEST_PATH: `${nodeBin}:${DEFAULT_GUEST_PATH}`,
        BIONILUX_HOST_PATHS: nodeBin,
        BIONILUX_FAKE_ROOT: '1',
        BIONILUX_LENIENT: '0',
        BIONILUX_ANDROID_PATHS: '1',
        PATH: `${nodeBin}${path.delimiter}${hostEnvironment.PATH ?? ''}`,
      },
      timeout: 10_000,
    }));
    if (result.timedOut || result.exitCode !== 0 || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(result.stdout.trim())) {
      const reason = result.timedOut
        ? 'runtime smoke probe timed out'
        : `runtime smoke probe failed (exit ${result.exitCode ?? 'unknown'}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`;
      throw new Error(reason);
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

  async _prepareRootfs(instance, signal) {
    const script = path.join(instance.backend, 'scripts', 'prepare-rootfs.sh');
    const hostEnvironment = hostExecutionEnvironment(this.hostLibraryPath);
    if (process.env.ANDROID_ROOT) await this._probeTermuxHostTools(instance.root, hostEnvironment, signal);
    let result;
    try {
      result = normaliseCommandResult(await this._runManaged({
        file: 'sh',
        args: [
          script,
          '--rootfs', instance.rootfs,
          '--relative-links',
          ...(hostEnvironment.BIONILUX_DNS_SERVERS === 'none'
            ? ['--no-dns']
            : hostEnvironment.BIONILUX_DNS_SERVERS
              ? ['--dns', hostEnvironment.BIONILUX_DNS_SERVERS.replaceAll(',', ' ')]
              : []),
        ],
        cwd: instance.root,
        env: hostEnvironment,
        timeout: 120_000,
        signal,
      }));
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('linux-')) throw error;
      throw linuxRuntimeError(
        'linux-rootfs-prepare-failed',
        `prepare-rootfs.sh could not start: ${String(error?.message ?? error)}`,
      );
    }
    if (result.exitCode !== 0) {
      throw linuxRuntimeError(
        'linux-rootfs-prepare-failed',
        `prepare-rootfs.sh failed with exit code ${result.exitCode}: ${result.stderr}`.trim(),
      );
    }
  }

  async _probeTermuxHostTools(cwd, environment, signal) {
    for (const [tool, signature] of Object.entries(GNU_HOST_TOOLS)) {
      let result;
      try {
        result = normaliseCommandResult(await this._runManaged({
          file: tool,
          args: ['--version'],
          cwd,
          env: environment,
          timeout: HOST_TOOL_PROBE_TIMEOUT_MS,
          signal,
        }));
      } catch (error) {
        throw linuxRuntimeError(
          'linux-host-toolchain-unavailable',
          `Termux ${tool} probe could not start: ${String(error?.message ?? error)}`,
        );
      }
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.timedOut || result.exitCode !== 0 || !signature.test(output)) {
        const evidence = output.trim().slice(0, 300) || 'no version output';
        throw linuxRuntimeError(
          'linux-host-toolchain-unavailable',
          `Termux ${tool} must be the GNU ${tool} utility (exit ${result.exitCode ?? 'unknown'}): ${evidence}`,
        );
      }
    }
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
    if (process.env.ANDROID_ROOT) {
      hostExecutionEnvironment(this.hostLibraryPath);
      await this._probeAndroidNativeLauncher();
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
      await this._probeRuntime(health);
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

  async _probeAndroidNativeLauncher() {
    const { launcher } = androidNativeRuntimeEntrypoints();
    let result;
    try {
      result = normaliseCommandResult(await this._runManaged({
        file: launcher,
        args: ['--print-config'],
        cwd: this.dataDir,
        env: bioniluxExecutionEnvironment(this.hostLibraryPath),
        timeout: HOST_TOOL_PROBE_TIMEOUT_MS,
      }));
    } catch (error) {
      throw linuxRuntimeError(
        'linux-host-exec-assets-unavailable',
        `APK native Bionilux launcher could not start: ${String(error?.message ?? error)}`,
      );
    }
    if (!nativeLauncherProbePassed(result)) {
      const evidence = (result.stderr || result.stdout).trim().slice(0, 300) || 'no launcher output';
      throw linuxRuntimeError(
        'linux-host-exec-assets-unavailable',
        `APK native Bionilux launcher probe failed (exit ${result.exitCode ?? 'unknown'}): ${evidence}`,
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
    return { guestCwd: cwd, hostPaths: [cwd] };
  }

  _executionEnvironment(paths, cwdInfo) {
    const environment = bioniluxExecutionEnvironment(this.hostLibraryPath);
    const nodeBin = path.join(paths.node, 'bin');
    const hostPaths = [nodeBin, ...cwdInfo.hostPaths];
    environment.BIONILUX_ROOTFS = paths.rootfs;
    environment.BIONILUX_PRELOAD = paths.preload;
    environment.BIONILUX_GUEST_CWD = cwdInfo.guestCwd;
    environment.BIONILUX_GUEST_PATH = `${nodeBin}:${DEFAULT_GUEST_PATH}`;
    environment.BIONILUX_HOST_PATHS = [...new Set(hostPaths)].join(':');
    environment.BIONILUX_FAKE_ROOT = '1';
    environment.BIONILUX_LENIENT = '0';
    environment.BIONILUX_ANDROID_PATHS = '1';
    environment.PATH = `${nodeBin}${path.delimiter}${environment.PATH ?? ''}`;
    return environment;
  }

  async execute({ command, cwd, timeout, signal } = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('command must be a non-empty string');
    }
    await this.gate.acquireShared();
    try {
      if (this.disposed) throw new Error('manager is disposed');
      const current = this.status();
      if (!current.healthy) {
        throw new Error(`Linux runtime is unavailable: ${current.reason ?? 'unhealthy'}`);
      }
      const cwdInfo = this._resolveCwd(cwd, current.paths.rootfs);
      const environment = this._executionEnvironment(current.paths, cwdInfo);
      const result = normaliseCommandResult(
        await this._runManaged({
          file: current.paths.launcher,
          args: ['/bin/bash', '-lc', command],
          cwd: this.dataDir,
          env: environment,
          timeout,
          signal,
        }),
      );
      return {
        ...result,
        cwd: cwdInfo.guestCwd,
        runtimeId: current.runtimeId,
        architecture: current.architecture,
      };
    } finally {
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
