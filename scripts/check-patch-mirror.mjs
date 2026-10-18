#!/usr/bin/env node
// check-patch-mirror.mjs — 补丁自洽门禁（0.13.8 PR-A1；apk issue #171 残留防线）
//
// 2026-10-15 按用户决定**收窄**：跨树逐字节镜像比对已整体移除。
//
// 真因：那条纪律的前提是「协调仓 = 权威源，本仓 = 供云端自包含构建检出的副本」——单边演进会
// 让云端快照静默缺引擎树补丁（幽灵缺陷，apk #171 的实锤成因）。本分支已改为**只从源码构建**
// 且明确**不依赖 kelai141 名下任何仓库**（AGENTS.md §4 铁律 9、SECURITY-HARDENING.md 的「独立」口径），
// 于是不存在需要对齐的第二棵树：本仓内的副本即权威。保留的是**本仓自洽面**：
//   · registry.json 可解析，补丁 id 双向闭合——登记了必须有实现，实现了必须有登记；
//   · apply-patches.mjs 的 IMPLS 非空且可解析。
// 其余相邻保护仍在别处：夹具代对齐 check-patch-fixtures.mjs、补丁行为回归
// check-patch-test-manifest.mjs、引擎 overlay check-engine-overlay.mjs、注入完整性
// check-inject-completeness.mjs。
//
// 为什么移除而不是「对端在场才比对」：对端缺席时它只打印 SKIP，本地看不出任何差别——单边改动
// 造成的漂移是**静默**的；而严格档（--peer / --require-peer）在我们这种单树公开检出里根本跑不起来
// （检出私有协调仓需要 PAT，0.14.0 实测已失效）。留着它只会制造「有防线」的错觉，并把权威写在
// 别人仓库上。移除只减断言、不加能力，不削弱本分支产物依赖的判据。
//
// 用法：node scripts/check-patch-mirror.mjs [--self]（--self 保留为兼容别名；本门禁现在只有自洽面）
// 退出码：0 = 通过；1 = 判据失败（构建链与 CI 以此拒打包/拒合并）；2 = 传了已移除的跨树参数。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)

// 已移除的跨树参数必须**显式拒绝**而不是静默忽略：静默忽略会让调用方以为比对发生了。
const removedFlags = argv.filter((a) => a === '--require-peer' || a === '--peer' || a.startsWith('--peer='))
if (removedFlags.length > 0 || process.env.DSH_MIRROR_PEER) {
  console.error('check-patch-mirror：跨树镜像比对已按用户决定移除（本分支不依赖协调仓，见 AGENTS.md §4 铁律 9）。' +
    ' 树内副本即权威；请改用不带 --peer / --require-peer 的调用形态。')
  process.exit(2)
}

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

// ── 自洽一致性（任一仓单独可跑） ──────────────────────────────────
const regPath = join(ROOT, 'scripts', 'patches', 'registry.json')
const implPath = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
let regIds = []
let implIds = []
try {
  regIds = JSON.parse(readFileSync(regPath, 'utf8')).patches.map((p) => p.id)
} catch (e) {
  check('registry.json 可解析', false, String(e).slice(0, 200))
}
try {
  const src = readFileSync(implPath, 'utf8')
  implIds = [...src.matchAll(/^  '([^']+)':\s*\{/gm)].map((m) => m[1])
  check('apply-patches.mjs IMPLS 条目非空', implIds.length > 0, `解析到 ${implIds.length} 条`)
} catch (e) {
  check('apply-patches.mjs 可读', false, String(e).slice(0, 200))
}
if (regIds.length > 0 && implIds.length > 0) {
  const regSet = new Set(regIds)
  const implSet = new Set(implIds)
  const missingImpl = regIds.filter((id) => !implSet.has(id))
  const missingReg = implIds.filter((id) => !regSet.has(id))
  check('registry id 集合 == IMPLS id 集合',
    missingImpl.length === 0 && missingReg.length === 0,
    `登记缺实现: [${missingImpl.join(', ')}]；实现缺登记: [${missingReg.join(', ')}]`)
}

if (failures.length > 0) {
  console.error(`CHECK-PATCH-MIRROR FAILED（${failures.length} 项）：${failures.join('；')}`)
  process.exit(1)
}
// 保留 SKIP 汇总形态：聚合入口与 check-gate-skips 按 SKIP=<n> 记账，本门禁现在不再产生 SKIP。
console.log('CHECK-PATCH-MIRROR PASSED（自洽面：id 双向闭合 + 实现可解析；SKIP=0）')
