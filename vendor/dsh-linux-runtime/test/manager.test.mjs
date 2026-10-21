import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { createManager, ExecutionGate, GUEST_PATH_PREFIXES, isGuestPath, spawnCommand } from '../modules/manager.js';
import { apply as applyRuntime } from '../lib/index.js';
import { validateManifest, validateAsset, selectRuntime } from '../modules/manifest.js';

const temporaryRoot = path.join(process.cwd(), '.deploy-tmp', `bionilux-runtime-tests-${process.pid}`);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const ARCHIVE_FILES = {
  node: {
    'bin/node': '#!/bin/sh\n',
    'lib/node_modules/npm/index.js': '// npm\n',
  },
  backend: {
    'bin/bionilux': '#!/bin/sh\n',
    'lib/libbionilux_preload.so': 'shared object\n',
    'scripts/prepare-rootfs.sh': '#!/bin/sh\n',
  },
  rootfs: {
    'bin/sh': '#!/bin/sh\n',
    'bin/bash': '#!/bin/sh\n',
    'usr/bin/apt-get': '#!/bin/sh\n',
    'usr/bin/dpkg': '#!/bin/sh\n',
    'etc/os-release': 'ID=debian\n',
  },
};

/** Build an asset whose downloaded bytes match its declared digest. */
function makeAsset(name, { body = `archive:${name}`, digestBody = null } = {}) {
  const bytes = Buffer.from(body);
  return {
    bytes,
    asset: {
      url: `https://github.com/kelai141/dsh-bionilux/releases/download/v1.0.0/${name}`,
      sha256: sha256(digestBody ? Buffer.from(digestBody) : bytes),
      size: bytes.length,
      unpackedSize: 1024,
    },
  };
}

function makeManifest({ nodeAsset, rootfsFiles = ARCHIVE_FILES.rootfs, version = '1.0.0' } = {}) {
  const backend = makeAsset('bionilux-backend-aarch64.tar.xz');
  const rootfs = makeAsset('debian-minimal-aarch64.tar.xz');
  const node = nodeAsset ?? makeAsset('node-glibc-v24.22.0-linux-arm64.tar.xz');
  return {
    bytes: { backend: backend.bytes, rootfs: rootfs.bytes, node: node.bytes },
    rootfsFiles,
    manifest: {
      schemaVersion: 1,
      version,
      minMobileVersion: '0.14.0',
      plugins: {
        bootstrap: makeAsset('linux-bootstrap-plugin.tar.xz').asset,
        runtime: makeAsset('linux-runtime-plugin.tar.xz').asset,
      },
      runtimes: [
        {
          id: 'debian-minimal',
          label: 'Debian minimal',
          architecture: 'arm64',
          backend: 'bionilux',
          backendAsset: backend.asset,
          rootfsAsset: rootfs.asset,
          nodeAsset: node.asset,
        },
      ],
    },
  };
}

/**
 * IO harness: downloads write the archive bytes the manifest declares, and the
 * safe extractor materializes the fake payload for each archive kind.
 */
function makeIo(fixture, { onExtract } = {}) {
  const stats = { downloads: [], extracts: [] };
  const io = {
    stats,
    downloadAsset: async (asset, destination) => {
      stats.downloads.push(path.basename(new URL(asset.url).pathname));
      const name = path.basename(new URL(asset.url).pathname);
      const bytes = name.includes('bionilux-backend')
        ? fixture.bytes.backend
        : name.includes('debian-minimal')
          ? fixture.bytes.rootfs
          : name.includes('node-glibc')
            ? fixture.bytes.node
            : fixture.bytes.backend;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    },
    extractArchive: async (_archive, destination, { kind } = {}) => {
      stats.extracts.push(kind);
      if (typeof onExtract === 'function') await onExtract(kind, destination);
      const files = kind === 'rootfs' ? fixture.rootfsFiles : ARCHIVE_FILES[kind];
      if (!files) throw new Error(`unknown archive kind ${kind}`);
      for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(destination, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
        if (relative.startsWith('bin/') || relative.startsWith('usr/bin/') || relative === 'bin/node') {
          const { chmod } = await import('node:fs/promises');
          await chmod(target, 0o755);
        }
      }
    },
  };
  return io;
}

/**
 * Command runner: everything resolves immediately except an explicitly held
 * command (`sleep ...`), which stays pending until the manager aborts or
 * cancels it — that is what the cutover gate has to do before it replaces an
 * active rootfs.
 */
function makeRunner({ instant, healthProbeResult = { stdout: 'v24.22.0', stderr: '', exitCode: 0 }, commandResult = { stdout: 'ok', stderr: '', exitCode: 0 }, onHealthProbe } = {}) {
  const calls = [];
  const isInstant =
    instant ?? ((spec) => !String(spec.args?.at(-1) ?? '').includes('sleep'));
  return {
    calls,
    runCommand(spec) {
      const record = { spec, aborted: false, cancelled: false, forceKilled: false, settled: false };
      calls.push(record);
      return {
        promise: new Promise((resolve) => {
          const settle = (result) => {
            if (record.settled) return;
            record.settled = true;
            resolve(result);
          };
          record.settle = settle;
          spec.signal?.addEventListener(
            'abort',
            () => {
              record.aborted = true;
              settle({ stdout: '', stderr: 'aborted', exitCode: 130 });
            },
            { once: true },
          );
          if (isInstant(spec)) {
            const healthProbe = spec.args?.[0] === 'node' && spec.args?.[1] === '--version';
            if (healthProbe) onHealthProbe?.(spec);
            settle(healthProbe ? healthProbeResult : commandResult);
          }
        }),
        cancel: () => {
          record.cancelled = true;
          record.settle?.({ stdout: '', stderr: 'cancelled', exitCode: 143 });
        },
        forceKill: () => {
          record.forceKilled = true;
          record.settle?.({ stdout: '', stderr: 'killed', exitCode: 137 });
        },
      };
    },
  };
}

function makeManager(fixture, { dataDir, ioOptions, runnerOptions, hostLibraryPath, arch = 'arm64' } = {}) {
  const io = makeIo(fixture, ioOptions);
  const runner = makeRunner(runnerOptions);
  const manager = createManager({
    dataDir,
    arch,
    hostLibraryPath,
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: runner.runCommand,
  });
  return { manager, io, runner };
}

let counter = 0;
function tempDir() {
  counter += 1;
  return path.join(temporaryRoot, `case-${counter}`);
}

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test('last shared release wakes an exclusive waiter and queued readers cannot overtake it', { timeout: 1000 }, async () => {
  const gate = new ExecutionGate();
  await gate.acquireShared();
  const order = [];
  const writer = gate.acquireExclusive().then(() => { order.push('writer'); });
  const reader = gate.acquireShared().then(() => { order.push('reader'); gate.releaseShared(); });
  await Promise.resolve();
  assert.deepEqual(order, []);
  gate.releaseShared();
  await writer;
  assert.deepEqual(order, ['writer']);
  gate.releaseExclusive();
  await reader;
  assert.deepEqual(order, ['writer', 'reader']);
  assert.equal(gate.busy, false);
});

test('multiple queued managers finish before newly queued commands', { timeout: 1000 }, async () => {
  const gate = new ExecutionGate();
  await gate.acquireShared();
  const order = [];
  const writers = [1, 2].map(n => gate.acquireExclusive().then(() => {
    order.push(n); gate.releaseExclusive();
  }));
  const reader = gate.acquireShared().then(() => { order.push('reader'); gate.releaseShared(); });
  gate.releaseShared();
  await Promise.all([...writers, reader]);
  assert.deepEqual(order, [1, 2, 'reader']);
  assert.equal(gate.active, 0);
});

test('spawnCommand bounds captured stdout and stderr while continuing to drain both pipes', async () => {
  const result = await spawnCommand({
    file: process.execPath,
    args: ['-e', 'process.stdout.write("o".repeat(300000)); process.stderr.write("e".repeat(300000))'],
    timeout: 10_000,
  }).promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 256 * 1024 + '\n[output truncated after 262144 bytes]'.length);
  assert.equal(result.stderr.length, 256 * 1024 + '\n[output truncated after 262144 bytes]'.length);
  assert.match(result.stdout, /\[output truncated after 262144 bytes\]$/);
  assert.match(result.stderr, /\[output truncated after 262144 bytes\]$/);
});

test('spawnCommand force-kills the process group when a timed-out child ignores SIGTERM', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process-group signal semantics required');
  const started = Date.now();
  const result = await spawnCommand({
    file: process.execPath,
    args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    timeout: 1000,
  }).promise;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(Date.now() - started >= 1400, 'SIGKILL should follow the bounded TERM grace period');
});

test('install stages, proves health, then activates the runtime', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  let activeDuringProbe;
  const { manager, io } = makeManager(fixture, {
    dataDir,
    runnerOptions: { onHealthProbe: () => { activeDuringProbe = existsSync(path.join(dataDir, 'active.json')); } },
  });

  assert.equal(manager.status().installed, false);
  assert.equal(manager.status().healthy, false);

  const status = await manager.install(fixture.manifest);

  assert.equal(status.healthy, true);
  assert.equal(status.installed, true);
  assert.equal(status.runtimeId, 'debian-minimal');
  assert.equal(status.version, '1.0.0');
  assert.equal(activeDuringProbe, false, 'the new runtime is not active until the smoke probe succeeds');

  const record = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));
  assert.equal(record.runtimeId, 'debian-minimal');
  assert.match(record.nodeKey, /^sha256-[a-f0-9]{64}$/);
  assert.deepEqual(io.stats.extracts.sort(), ['backend', 'node', 'rootfs']);
});

test('a failing install leaves the previous active runtime untouched', async () => {
  const dataDir = tempDir();
  const good = makeManifest();
  const { manager } = makeManager(good, { dataDir });
  const first = await manager.install(good.manifest);
  assert.equal(first.healthy, true);

  const brokenRootfs = { ...ARCHIVE_FILES.rootfs };
  delete brokenRootfs['usr/bin/dpkg'];
  const broken = makeManifest({ version: '1.1.0', rootfsFiles: brokenRootfs });
  const { manager: second } = makeManager(broken, { dataDir });

  await assert.rejects(() => second.install(broken.manifest, 'debian-minimal'), /unhealthy|rootfs file is missing/);

  const after = second.status();
  assert.equal(after.healthy, true, 'the previously active instance must stay active');
  assert.equal(after.version, '1.0.0');
  const record = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));
  assert.equal(record.version, '1.0.0');
});

test('a runtime that fails the launch smoke probe cannot replace the active instance', async () => {
  const dataDir = tempDir();
  const firstFixture = makeManifest();
  const first = makeManager(firstFixture, { dataDir });
  const installed = await first.manager.install(firstFixture.manifest);
  const activeBefore = await readFile(path.join(dataDir, 'active.json'), 'utf8');
  const secondFixture = makeManifest({ version: '1.0.1' });
  const second = makeManager(secondFixture, {
    dataDir,
    runnerOptions: { healthProbeResult: { stdout: '', stderr: 'ELF load failed', exitCode: 1 } },
  });

  await assert.rejects(() => second.manager.install(secondFixture.manifest), /runtime smoke probe failed/);
  assert.equal(await readFile(path.join(dataDir, 'active.json'), 'utf8'), activeBefore);
  assert.equal(second.manager.status().instanceId, installed.instanceId);
});

test('old-instance cleanup failure preserves the committed runtime across manager restart', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  const before = await manager.install(fixture.manifest);
  manager._removePreviousInstance = async () => { throw new Error('controlled old-instance cleanup failure'); };
  const after = await manager.reinstall(fixture.manifest);
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal(after.healthy, true);
  assert.match(after.cleanupWarning, /controlled old-instance/);
  const restarted = makeManager(fixture, { dataDir }).manager;
  assert.equal(restarted.status().healthy, true);
  assert.equal(restarted.status().instanceId, after.instanceId);
  assert.equal(existsSync(path.join(dataDir, 'instances', before.instanceId)), true);
  assert.equal((await restarted.execute({ command: 'echo usable' })).exitCode, 0);
});

test('throwing state observers cannot destroy committed instances or starve later observers', async () => {
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir: tempDir() });
  const observed = [];
  manager.on('change', () => { throw new Error('observer failed'); });
  manager.on('change', state => observed.push(state));
  let once = 0;
  manager.events.once('change', () => { once++; throw new Error('once failed'); });
  await manager.install(fixture.manifest);
  const after = await manager.reinstall(fixture.manifest);
  assert.equal(after.healthy, true);
  assert.equal(observed.length, 2);
  assert.equal(once, 1);
  assert.equal(manager.status().instanceId, after.instanceId);
});

test('active-pointer write failure retains the previous pointer and removes only the staged instance', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  const before = await manager.install(fixture.manifest);
  const pointer = await readFile(path.join(dataDir, 'active.json'), 'utf8');
  manager._writeActive = async () => { throw new Error('controlled pointer write failure'); };
  await assert.rejects(manager.reinstall(fixture.manifest), /controlled pointer/);
  assert.equal(await readFile(path.join(dataDir, 'active.json'), 'utf8'), pointer);
  assert.equal(manager.status().instanceId, before.instanceId);
  assert.equal(manager.status().healthy, true);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(dataDir, 'instances')), [before.instanceId]);
});

test('scope disposal stops owned commands and a retained disposed handle can still uninstall data', { timeout: 3000 }, async () => {
  const fixture = makeManifest(), dataDir = tempDir();
  const io = makeIo(fixture), runner = makeRunner();
  let dispose;
  const manager = applyRuntime({ tools: { register: () => () => {} }, provide() {}, effect(fn) { dispose = fn(); } }, {
    dataDir, downloadAsset: io.downloadAsset, extractArchive: io.extractArchive, runCommand: runner.runCommand,
  });
  await manager.install(fixture.manifest);
  const running = manager.execute({ command: 'sleep 100' });
  await new Promise(resolve => setImmediate(resolve));
  try {
    await dispose();
    assert.equal(manager.disposed, true);
    assert.equal((await running).exitCode, 130);
    await assert.rejects(manager.execute({ command: 'echo stale' }), /disposed/);
    const removed = await manager.uninstall();
    assert.equal(removed.installed, false);
    assert.equal(existsSync(path.join(dataDir, 'active.json')), false);
  } finally { await manager.dispose(); }
});

test('scope disposal does not take ownership of an externally supplied manager', async () => {
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir: tempDir() });
  let dispose;
  applyRuntime({ tools: { register: () => () => {} }, provide() {}, effect(fn) { dispose = fn(); } }, { manager });
  await dispose();
  assert.equal(manager.disposed, false);
  await manager.dispose();
});

test('shared glibc Node is downloaded once and reused across releases', async () => {
  const dataDir = tempDir();
  const first = makeManifest({ version: '1.0.0' });
  const { manager } = makeManager(first, { dataDir });
  await manager.install(first.manifest);

  const nodeDownloads = () => {
    const shared = path.join(dataDir, 'shared', 'node');
    return existsSync(shared) ? [path.join(shared)] : [];
  };
  assert.equal(nodeDownloads().length, 1);

  // A new Linux release that ships the same Node archive must not re-download it.
  const second = makeManifest({ version: '1.1.0' });
  const io = makeIo(second);
  const next = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: makeRunner().runCommand,
  });
  await next.install(second.manifest);

  assert.equal(io.stats.downloads.filter((name) => name.includes('node-glibc')).length, 0);
  assert.equal(next.status().version, '1.1.0');
  assert.equal(next.status().healthy, true);
});

test('a different shared Node archive installs alongside and retires the old one', async () => {
  const dataDir = tempDir();
  const first = makeManifest({ version: '1.0.0' });
  const { manager } = makeManager(first, { dataDir });
  await manager.install(first.manifest);

  const upgraded = makeManifest({ version: '1.1.0', nodeAsset: makeAsset('node-glibc-v25.0.0-linux-arm64.tar.xz') });
  const io = makeIo(upgraded);
  const next = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: makeRunner().runCommand,
  });
  await next.install(upgraded.manifest);

  assert.equal(io.stats.downloads.filter((name) => name.includes('node-glibc')).length, 1);
  const record = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));
  assert.equal(record.nodeKey, `sha256-${upgraded.manifest.runtimes[0].nodeAsset.sha256}`);
});

test('the cutover stops in-flight commands and blocks new ones until it finishes', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);
  const beforeCutover = runner.calls.length;

  const running = manager.execute({ command: 'sleep 100', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Upgrade on the same manager instance: one manager owns one data directory.
  const replacement = makeManifest({ version: '1.1.0' });
  const installed = await manager.install(replacement.manifest);
  const result = await running;

  assert.equal(result.exitCode, 130, 'the in-flight command was aborted, not silently dropped');
  assert.equal(runner.calls.length > beforeCutover, true);
  assert.equal(installed.healthy, true);
  assert.equal(manager.status().version, '1.1.0');
});

test('a command issued during a cutover waits for it instead of running against a replaced rootfs', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const installPromise = manager.install(fixture.manifest);
  const queued = manager.execute({ command: 'echo after' });

  const installed = await installPromise;
  const result = await queued;

  assert.equal(installed.healthy, true);
  assert.equal(result.exitCode, 0);
  const lastSpec = runner.calls.at(-1).spec;
  assert.equal(lastSpec.args.at(-1), 'echo after');
});

test('uninstall removes the instance and unreferenced Node but keeps foreign data', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const foreign = path.join(dataDir, 'workspaces', 'project');
  await mkdir(foreign, { recursive: true });
  await writeFile(path.join(foreign, 'keep.txt'), 'user data\n');

  const status = await manager.uninstall();

  assert.equal(status.installed, false);
  assert.equal(existsSync(path.join(dataDir, 'instances')), true);
  assert.equal(existsSync(path.join(dataDir, 'shared', 'node')), true);
  assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'user data\n');
  const shared = path.join(dataDir, 'shared', 'node');
  if (existsSync(shared)) {
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(shared), []);
  }
});

test('the guest environment is derived, not inherited from the host', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  runner.calls.length = 0;
  await manager.execute({ command: 'echo hi' });
  const spec = runner.calls.at(-1).spec;
  const env = spec.env;

  for (const leaked of ['PREFIX', 'TERMUX_VERSION', 'LD_PRELOAD', 'NODE_OPTIONS', 'npm_config_prefix']) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the guest`);
  }
  assert.equal(env.BIONILUX_ROOTFS, manager.status().paths.rootfs);
  assert.equal(env.BIONILUX_LENIENT, '0');
  assert.match(env.BIONILUX_GUEST_PATH, /lib\/node_modules\/npm|bin:.*\/usr\/bin/);
  assert.equal(env.BIONILUX_GUEST_PATH.startsWith(path.join(manager.status().paths.node, 'bin')), true);
  assert.equal(spec.args[0], '/bin/bash');
  assert.equal(spec.args[1], '-lc');
  assert.equal(spec.args[2], 'echo hi');
});

test('Termux host libraries reach host tools and the launcher only', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const hostLibraryPath = path.join(dataDir, 'usr', 'lib');
  await mkdir(hostLibraryPath, { recursive: true });
  const keys = ['DSH_FILES_DIR', 'ANDROID_ROOT', 'LD_LIBRARY_PATH'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DSH_FILES_DIR = dataDir;
  process.env.ANDROID_ROOT = '/system';
  process.env.LD_LIBRARY_PATH = '/untrusted/inherited/lib';
  try {
    const { manager, runner } = makeManager(fixture, { dataDir });
    await manager.install(fixture.manifest);

    const prepare = runner.calls.find(({ spec }) => spec.file === 'sh')?.spec;
    const probe = runner.calls.find(({ spec }) => spec.args?.[0] === 'node' && spec.args?.[1] === '--version')?.spec;
    assert.ok(prepare, 'rootfs preparation must invoke the host shell');
    assert.ok(probe, 'installation must probe the runtime through Bionilux');
    assert.equal(prepare.env.LD_LIBRARY_PATH, hostLibraryPath, 'derive the library directory from DSH_FILES_DIR');
    assert.equal(probe.env.LD_LIBRARY_PATH, hostLibraryPath);

    runner.calls.length = 0;
    await manager.execute({ command: 'echo guest' });
    const guest = runner.calls.at(-1).spec;
    assert.equal(guest.env.LD_LIBRARY_PATH, hostLibraryPath, 'the launcher itself needs the host loader path');
    assert.equal(guest.env.LD_PRELOAD, undefined);
    for (const leaked of ['PREFIX', 'TERMUX_VERSION', 'TERMUX_EXEC__EXECVE_CALL__INTERCEPT']) {
      assert.equal(guest.env[leaked], undefined, `${leaked} must not reach the launcher environment`);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rootfs preparation fails with a stable code when the Termux library directory is unavailable', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, {
    dataDir,
    hostLibraryPath: path.join(dataDir, 'missing', 'usr', 'lib'),
  });

  await assert.rejects(manager.install(fixture.manifest), error => {
    assert.equal(error.code, 'linux-host-library-path-unavailable');
    assert.match(error.message, /Termux host library directory is unavailable/);
    return true;
  });
  assert.equal(runner.calls.some(({ spec }) => spec.file === 'sh'), false, 'do not run host tools with an unresolved loader path');
});

test('rootfs script failures carry a stable diagnostic code', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const hostLibraryPath = path.join(dataDir, 'usr', 'lib');
  await mkdir(hostLibraryPath, { recursive: true });
  const { manager } = makeManager(fixture, {
    dataDir,
    hostLibraryPath,
    runnerOptions: { commandResult: { stdout: '', stderr: 'find: Permission denied', exitCode: 1 } },
  });

  await assert.rejects(manager.install(fixture.manifest), error => {
    assert.equal(error.code, 'linux-rootfs-prepare-failed');
    assert.match(error.message, /find: Permission denied/);
    return true;
  });
});

test('cwd inside the rootfs becomes a guest path, and relative cwd is rejected', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);
  const rootfs = manager.status().paths.rootfs;
  await mkdir(path.join(rootfs, 'work'), { recursive: true });

  runner.calls.length = 0;
  const inside = await manager.execute({ command: 'pwd', cwd: path.join(rootfs, 'work') });
  assert.equal(inside.cwd, '/work');
  const nodeBin = path.join(manager.status().paths.node, 'bin');
  // The list is colon-separated for the POSIX guest; on a Windows host an
  // absolute path itself contains ':', so compare by position instead of by
  // splitting.
  assert.equal(
    String(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS).startsWith(nodeBin),
    true,
    'the shared Linux Node bin directory must stay reachable from the guest',
  );

  const guestPath = await manager.execute({ command: 'pwd', cwd: '/root' });
  assert.equal(guestPath.cwd, '/root');
  assert.equal(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS.includes('/root'), false);

  await assert.rejects(() => manager.execute({ command: 'pwd', cwd: 'relative/path' }), /absolute path/);
});

test('a working directory in the guest namespace is never promoted to a host pass-through', { skip: process.platform === 'win32' }, async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  // /tmp exists on the host and is also a guest path: promoting it would shadow
  // the guest's own /tmp, so the cwd must stay a guest path.
  const guestNamespaceDir = path.posix.join('/tmp', `bionilux-guest-ns-${process.pid}`);
  await mkdir(guestNamespaceDir, { recursive: true });

  runner.calls.length = 0;
  const result = await manager.execute({ command: 'pwd', cwd: guestNamespaceDir });

  assert.equal(result.cwd, guestNamespaceDir);
  assert.equal(
    String(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS).includes(guestNamespaceDir),
    false,
    'the guest namespace must not be shadowed',
  );
});

test('a host workspace outside the guest namespace stays visible under its own name', async () => {
  const dataDir = tempDir();
  // On platforms whose temp root is itself a guest path (Linux CI: /tmp) this
  // case cannot be exercised without shadowing the guest namespace, so it is
  // reported as skipped rather than asserted.
  const guestPrefixed = GUEST_PATH_PREFIXES.some((prefix) => dataDir === prefix || dataDir.startsWith(`${prefix}${path.sep}`) || dataDir.startsWith(`${prefix}/`));
  if (guestPrefixed) return;

  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const shared = path.join(dataDir, 'workspaces', 'project');
  await mkdir(shared, { recursive: true });

  runner.calls.length = 0;
  const outside = await manager.execute({ command: 'pwd', cwd: shared });

  assert.equal(outside.cwd, shared);
  assert.equal(
    String(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS).endsWith(shared),
    true,
    'a real host workspace must stay reachable',
  );
});

test('the guest namespace list covers the directories the rootfs owns', () => {
  for (const required of ['/etc', '/usr', '/tmp', '/var', '/home', '/root']) {
    assert.equal(GUEST_PATH_PREFIXES.includes(required), true, `${required} must be in the guest namespace`);
  }
  assert.equal(isGuestPath('/etc'), true);
  assert.equal(isGuestPath('/etc/os-release'), true);
  assert.equal(isGuestPath('/etcetera'), false, 'prefix matching must not leak to similar names');
  assert.equal(isGuestPath('/data/data/com.dsharnessmobile.shell/files'), false);
});

test('execution fails closed when the runtime is absent, and never falls back to the host', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });

  await assert.rejects(() => manager.execute({ command: 'echo hi' }), /Linux runtime is unavailable/);
  assert.equal(runner.calls.length, 0, 'no host shell may be spawned as a fallback');
});

test('reinstall replaces the instance without leaving a stale active record', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);
  const first = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));

  const status = await manager.reinstall(fixture.manifest);
  const second = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));

  assert.equal(status.healthy, true);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(existsSync(path.join(dataDir, 'instances', first.instanceId)), false);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(dataDir, '.staging')), []);
});

test('manifest validation rejects unsafe assets and unsupported selections', () => {
  const fixture = makeManifest();
  assert.equal(validateManifest(fixture.manifest).runtimes[0].id, 'debian-minimal');

  const httpUrl = structuredClone(fixture.manifest);
  httpUrl.plugins.runtime.url = 'http://github.com/kelai141/dsh-bionilux/releases/download/v1.0.0/linux-runtime-plugin.tar.xz';
  assert.throws(() => validateManifest(httpUrl), /HTTPS/i);

  const badDigest = structuredClone(fixture.manifest);
  badDigest.plugins.runtime.sha256 = 'nope';
  assert.throws(() => validateManifest(badDigest), /sha256/);

  const duplicate = structuredClone(fixture.manifest);
  duplicate.runtimes.push({ ...duplicate.runtimes[0] });
  assert.throws(() => validateManifest(duplicate), /duplicate/);

  const traversal = structuredClone(fixture.manifest);
  traversal.runtimes[0].id = '../escape';
  assert.throws(() => validateManifest(traversal), /unsafe path/);

  assert.throws(() => selectRuntime(fixture.manifest, 'debian-minimal', 'x64'), /not present in the manifest/);
  assert.throws(() => validateAsset({ url: fixture.manifest.runtimes[0].rootfsAsset.url, sha256: 'a'.repeat(64), size: 0, unpackedSize: 1 }), /size/);
});
