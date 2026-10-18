import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { OWNER, REPO } from '../src/assets/release.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const tag = 'v0.14.7';
const arm = 'a'.repeat(64);
const asset = abi => `pocket-harness-${tag}-${abi}.apk`;
const assets = ['arm64'].map(abi => ({ name: asset(abi), size: 100 }));

test('offline seed and refresh round-trip preserve release identity and checksums', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-delivery-'));
  try {
    for (const dir of ['src', 'tools', 'data']) fs.cpSync(path.join(root, dir), path.join(scratch, dir), { recursive: true });
    const preload = path.join(scratch, 'network.mjs');
    fs.writeFileSync(preload, `
globalThis.fetch = async url => {
  if (process.env.PAGES_TEST_OFFLINE === '1') throw new Error('controlled offline');
  // status/url 必须给全：build.mjs 的 fetchText 会校验 res.url 的 host（拒绝 MANIFEST 被重定向到
  // 非 GitHub 官方主机），缺 url 时 new URL(undefined) 抛 Invalid URL 并被上层吞成
  // 「MANIFEST 不可用」警告——sha256 会被静默丢弃，正是本用例要抓的那种静默降级。
  const target = String(url);
  if (target.includes('api.github.com')) return { ok: true, status: 200, url: target, json: async () => (${JSON.stringify({ tag_name: tag, published_at: '2026-10-14T00:00:00Z', assets })}) };
  return { ok: true, status: 200, url: target, text: async () => ${JSON.stringify(`${arm}  apk/${asset('arm64')}  100`)} };
};`);
    const run = (offline, refresh = false) => {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs'), ...(refresh ? ['--refresh'] : [])], {
        encoding: 'utf8', env: { ...process.env, PAGES_TEST_OFFLINE: offline ? '1' : '0' },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const data = JSON.parse(fs.readFileSync(path.join(scratch, 'dist/data/releases.json')));
      const html = fs.readFileSync(path.join(scratch, 'dist/index.html'), 'utf8');
      if (data.tag) {
        assert.equal(data.tag, tag);
        assert.match(html, /"tag":"v0.14.7"/);
      } else {
        assert.match(html, /"tag":null/);
      }
      return data;
    };
    const empty = run(true);
    assert.equal(empty.source, 'seed');
    assert.equal(empty.tag, null);
    assert.deepEqual(run(false, true).sha256, { arm64: arm });
    const restored = run(true);
    assert.equal(restored.publishedAt, '2026-10-14T00:00:00Z');
    // 离线档**不得**沿用种子里的哈希：只有取自官方 MANIFEST 的 sha256 才允许进页面
    // （种子可能来自更早、曾信任第三方镜像的构建，见 build.mjs 的 normalize 注释）。
    // 页面在这种情况下会明确提示「到 Releases 自行核对」，所以空哈希是正确结果而不是降级失败。
    assert.deepEqual(restored.sha256, {});
    // Malformed fallback input must fail rather than publish an unidentified release.
    fs.writeFileSync(path.join(scratch, 'data/releases.json'), '{}');
    const bad = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs')], {
      encoding: 'utf8', env: { ...process.env, PAGES_TEST_OFFLINE: '1' },
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /no valid tag/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('source release draft selects its real asset and fetches SHA256SUMS.txt checksum', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-source-delivery-'));
  try {
    for (const dir of ['src', 'tools', 'data']) fs.cpSync(path.join(root, dir), path.join(scratch, dir), { recursive: true });
    const sourceTag = 'hardening-source-bb8176a9ca99-39050643684-1';
    const sourceApk = 'pocket-harness-v0.14.7-source-arm64.apk';
    const digest = 'd'.repeat(64);
    const sourceAssets = [
      { name: sourceApk, size: 161215810 },
      { name: 'provenance.zip', size: 2837504 },
      { name: 'SHA256SUMS.txt', size: 256 },
      { name: 'notes.md', size: 512 },
    ];
    const preload = path.join(scratch, 'network.mjs');
    fs.writeFileSync(preload, `
globalThis.fetch = async url => {
  const target = String(url);
  if (target.includes('api.github.com')) {
    return { ok: true, status: 200, url: target, json: async () => (${JSON.stringify({
      tag_name: sourceTag, published_at: '2026-10-18T00:00:00Z', assets: sourceAssets,
    })}) };
  }
  // 旧实现只找 MANIFEST.txt；来源草稿没有这个文件。这里对非 SHA256SUMS.txt 请求直接失败，
  // 确保用例的绿只能来自“按生产合同取来源校验文件”，而不是碰巧回落到其他内容。
  if (target.endsWith('/SHA256SUMS.txt')) {
    return { ok: true, status: 200, url: target, text: async () => ${JSON.stringify(`${digest}  ${sourceApk}\n`)} };
  }
  throw new Error('unexpected fetch: ' + target);
};`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const data = JSON.parse(fs.readFileSync(path.join(scratch, 'dist/data/releases.json')));
    assert.equal(data.tag, sourceTag);
    assert.equal(data.sha256.arm64, digest, '来源校验值未从 SHA256SUMS.txt 注入');
    assert.equal(data.checksumFile, 'SHA256SUMS.txt');
    assert.equal(data.checksumUrl,
      `https://github.com/${OWNER}/${REPO}/releases/download/${sourceTag}/SHA256SUMS.txt`);
    const html = fs.readFileSync(path.join(scratch, 'dist/index.html'), 'utf8');
    // 下载页由内联数据驱动：归档下载地址和校验文件都必须指向来源草稿的真实 tag/资产。
    assert.ok(html.includes(`"downloadUrl":"https://github.com/${OWNER}/${REPO}/releases/download/${sourceTag}/${sourceApk}"`),
      'JSON-LD 未声明来源资产下载地址');
    assert.ok(html.includes('"checksumFile":"SHA256SUMS.txt"'));
    assert.ok(html.includes(`"checksumUrl":"https://github.com/${OWNER}/${REPO}/releases/download/${sourceTag}/SHA256SUMS.txt"`));
    assert.doesNotMatch(html, /MANIFEST\.txt/, '来源页面不得继续引用 MANIFEST.txt');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('actual app renders the selected checksum, switches ABI, and handles missing hashes', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-app-'));
  try {
    const runner = path.join(scratch, 'render.mjs');
    const appUrl = pathToFileURL(path.join(root, 'src/assets/app.js')).href;
    fs.writeFileSync(runner, `
import assert from 'node:assert/strict';
const release = ${JSON.stringify({ tag, assets, sha256: { arm64: arm } })};
const nodes = new Map();
const node = () => ({ textContent: '', innerHTML: '', dataset: {}, children: [],
  setAttribute(name, value) { this[name] = value; },
  appendChild(child) { this.children.push(child); },
  querySelectorAll() { return this.children; }, querySelector() { return null; },
  addEventListener(type, callback) { this[type] = callback; } });
const get = id => {
  if (!nodes.has(id)) nodes.set(id, node());
  return nodes.get(id);
};
get('release-data').textContent = JSON.stringify(release);
globalThis.document = { getElementById: get, createElement: node };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Linux armv8l', userAgent: '', onLine: false }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.fetch = async () => { throw new Error('controlled offline'); };
await import(${JSON.stringify(appUrl)});
await new Promise(resolve => setImmediate(resolve));
const html = () => get('dl-body').innerHTML;
assert.ok(html().includes(release.sha256.arm64));
assert.ok(!html().includes('x86_64'));
// Reopen the same module in a fresh generation with the missing checksum.
delete release.sha256.arm64;
get('release-data').textContent = JSON.stringify(release);
navigator.platform = 'Linux arm64';
await import(${JSON.stringify(appUrl + '?missing')});
await new Promise(resolve => setImmediate(resolve));
assert.ok(html().includes('未提供内联校验值'));
assert.ok(!html().includes('[object Object]'));
release.sha256 = {};
get('release-data').textContent = JSON.stringify(release);
await import(${JSON.stringify(appUrl + '?empty')});
await new Promise(resolve => setImmediate(resolve));
assert.ok(html().includes('未提供内联校验值'));
assert.ok(!html().includes('[object Object]'));
`);
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('site deployment stays manual until independent branding and downloads are ready', () => {
  const workflow = fs.readFileSync(path.join(root, '../.github/workflows/pages.yml'), 'utf8');
  assert.doesNotMatch(workflow, /\n  release:\s*\n/);
  assert.match(workflow, /\n  workflow_dispatch:\s*\n/);
  assert.doesNotMatch(workflow, /\n  push:\s*\n/);
  assert.doesNotMatch(workflow, /\n  workflow_run:/);
});

test('source draft page renders the SHA256SUMS link and never calls its asset "历史资产名"', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-source-app-'));
  try {
    const runner = path.join(scratch, 'render-source.mjs');
    const appUrl = pathToFileURL(path.join(root, 'src/assets/app.js')).href;
    const sourceTag = 'hardening-source-bb8176a9ca99-39050643684-1';
    const sourceApk = 'pocket-harness-v0.14.7-source-arm64.apk';
    const digest = 'e'.repeat(64);
    const checksumUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${sourceTag}/SHA256SUMS.txt`;
    const release = {
      tag: sourceTag,
      assets: [{ name: sourceApk, size: 161215810 }, { name: 'SHA256SUMS.txt', size: 256 }],
      sha256: { arm64: digest },
      checksumFile: 'SHA256SUMS.txt',
      checksumUrl,
    };
    fs.writeFileSync(runner, `
import assert from 'node:assert/strict';
const release = ${JSON.stringify(release)};
const nodes = new Map();
const node = () => ({ textContent: '', innerHTML: '', dataset: {}, children: [],
  setAttribute(name, value) { this[name] = value; },
  appendChild(child) { this.children.push(child); },
  querySelectorAll() { return this.children; }, querySelector() { return null; },
  addEventListener(type, callback) { this[type] = callback; } });
const get = id => {
  if (!nodes.has(id)) nodes.set(id, node());
  return nodes.get(id);
};
get('release-data').textContent = JSON.stringify(release);
globalThis.document = { getElementById: get, createElement: node };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Linux arm64', userAgent: '', onLine: false }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.fetch = async () => { throw new Error('controlled offline'); };
const html = () => get('dl-body').innerHTML;
await import(${JSON.stringify(appUrl)});
await new Promise(resolve => setImmediate(resolve));
assert.ok(html().includes(${JSON.stringify(checksumUrl)}), '页面必须链接到真实 SHA256SUMS.txt');
assert.ok(html().includes('SHA256SUMS.txt'));
assert.ok(!html().includes('历史资产名'), '来源资产不是历史命名，不得误告警');
assert.ok(html().includes(${JSON.stringify(digest)}));
// 校验值缺席时，兜底文案也必须指向来源校验文件，而不是 MANIFEST.txt。
delete release.sha256.arm64;
get('release-data').textContent = JSON.stringify(release);
await import(${JSON.stringify(appUrl + '?source-missing')});
await new Promise(resolve => setImmediate(resolve));
assert.ok(html().includes('未提供内联校验值'));
assert.ok(html().includes(${JSON.stringify(checksumUrl)}));
assert.doesNotMatch(html(), /MANIFEST\\.txt/);
`);
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
