import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeZip, readZip } from '../lib/zip.mjs';

// A previous core can be selected for a controlled negative run.
const { importSnapshots, encryptBuffer } = await import(pathToFileURL(
  process.env.DSH_UNDO_IMPORT_UUT ?? fileURLToPath(new URL('../lib/core.mjs', import.meta.url)),
).href);

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'undo-import-private-'));
  try {
    const cfg = { autoDir: join(root, 'store', 'auto'), manualDir: join(root, 'store', 'manual') };
    const zip = join(root, 'shared', 'backup.zip');
    await mkdir(join(root, 'shared'));
    const id = '20261017-120000-abcd';
    const manifest = Buffer.from(JSON.stringify({ kind: 'manual', id }));
    await writeZip(zip, [{ name: `manual/${id}/manifest.json`, data: manifest }]);
    const bytes = await readFile(zip);
    await run({ cfg, zip, id, manifest, bytes });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('encrypted production import never modifies an adjacent attacker-owned file', () => fixture(async ({ cfg, zip, id, manifest, bytes }) => {
  const adjacent = `${zip}.dec.tmp`;
  const sentinel = Buffer.from('unrelated data must survive');
  await writeFile(adjacent, sentinel);
  await writeFile(zip, encryptBuffer(bytes, 'test-password'));
  const result = await importSnapshots(cfg, zip, 'test-password');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.imported, 1);
  assert.deepEqual(await readFile(join(cfg.manualDir, id, 'manifest.json')), manifest);
  assert.deepEqual(await readFile(adjacent), sentinel);
}));

test('encrypted production import creates no plaintext sibling', () => fixture(async ({ cfg, zip, bytes }) => {
  // A directory at the old temporary pathname used to block a valid import.
  await mkdir(`${zip}.dec.tmp`);
  await writeFile(zip, encryptBuffer(bytes, 'password'));
  const result = await importSnapshots(cfg, zip, 'password');
  assert.equal(result.ok, true, result.error);
  assert.equal((await lstat(`${zip}.dec.tmp`)).isDirectory(), true);
}));

test('encrypted import cannot follow an attacker-prepared plaintext symlink', { skip: process.platform === 'win32' }, () => fixture(async ({ cfg, zip, bytes }) => {
  const target = join(cfg.manualDir, '..', 'unrelated-secret');
  await mkdir(join(cfg.manualDir, '..'), { recursive: true });
  await writeFile(target, 'original');
  await symlink(target, `${zip}.dec.tmp`);
  await writeFile(zip, encryptBuffer(bytes, 'password'));
  const result = await importSnapshots(cfg, zip, 'password');
  assert.equal(result.ok, true, result.error);
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal((await lstat(`${zip}.dec.tmp`)).isSymbolicLink(), true);
}));

test('ZIP reader parses checked bytes after the pathname has been replaced', () => fixture(async ({ zip, bytes, manifest }) => {
  await writeFile(zip, 'replaced untrusted source');
  const entries = await readZip(bytes);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].data, manifest);
}));

test('plain import and wrong-password rejection preserve existing behavior', () => fixture(async ({ cfg, zip, bytes }) => {
  assert.equal((await importSnapshots(cfg, zip)).ok, true);
  await writeFile(zip, encryptBuffer(bytes, 'right'));
  const result = await importSnapshots(cfg, zip, 'wrong');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bad-password');
}));
