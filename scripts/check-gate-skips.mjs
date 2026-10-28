#!/usr/bin/env node
// check-gate-skips.mjs — 门禁覆盖清单化 + SKIP 纪律门禁（0.13.8-b ST-31）。
//
// 断言：
//   1. 门禁清单 == 实际文件：check-release-gates.mjs 声明集合里的每个脚本都在 scripts/ 存在；
//      两条构建链（build-apk-013.ps1 / build-apk.mjs）调用的 check-*.mjs 都被声明集合覆盖
//      （覆盖清单化：不允许「有人加了一道门禁但没人接线」或反之）；
//   2. SKIP 必须计数且可见：任何 console 输出的 SKIP 行必须带计数器（SKIP(#n)）或显式 SKIP=n，
//      且该脚本必须在结尾打印汇总 SKIP=（发布链据此判 SKIP=0）；
//   3. 发布链 SKIP=0：build-release.ps1（两树）必须以 --run --require 调聚合入口，
//      且聚合入口对支持 --require 的门禁逐个传参。
//
// 用法：node scripts/check-gate-skips.mjs [--list]
// 退出码：0 = 通过；1 = 失败；2 = 布局不可解析。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SCRIPTS = join(ROOT, 'scripts')
const argv = process.argv.slice(2)

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
const DECLARED_RE = /\{ script: '([a-z0-9-]+\.mjs)'/g
/** 从聚合入口源码提取声明集合（纯函数：自测可直接喂合成文本）。 */
const parseDeclared = (text) => [...text.matchAll(DECLARED_RE)].map((m) => m[1])

/** 宽松的名字出现扫描，只用于「门禁被提及」的正向断言。 */
const parseInvoked = (text) =>
  [...new Set([...text.matchAll(/["'\\/](check-[a-z0-9-]+\.mjs|elf-check\.mjs)/g)].map((m) => m[1]))]

/** 读取普通 JS 字符串，供源码扫描器跳过注释与非执行文本。 */
const readQuoted = (text, start) => {
  const quote = text[start]
  if (quote !== "'" && quote !== '"') return null
  let value = ''
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) { value += text[i + 1]; i += 1; continue }
    if (ch === quote) return { value, end: i + 1 }
    value += ch
  }
  return null
}

/** 返回模板插值中匹配的 `}`；字符串、注释、对象字面量和嵌套模板不参与外层计数。 */
function templateExpressionEnd(text, start) {
  let depth = 0
  for (let i = start; i < text.length;) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (text[i] === "'" || text[i] === '"') {
      const literal = readQuoted(text, i)
      if (literal === null) return -1
      i = literal.end
      continue
    }
    if (text[i] === '`') {
      const nested = readTemplate(text, i)
      if (nested === null) return -1
      i = nested.end
      continue
    }
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      if (depth === 0) return i
      depth -= 1
    }
    i += 1
  }
  return -1
}

/** 模板文本不执行；只返回 `${...}` 中实际执行的表达式供扫描器递归检查。 */
function readTemplate(text, start) {
  const expressions = []
  for (let i = start + 1; i < text.length;) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === '`') return { expressions, end: i + 1 }
    if (text.startsWith('${', i)) {
      const end = templateExpressionEnd(text, i + 2)
      if (end < 0) return null
      expressions.push(text.slice(i + 2, end))
      i = end + 1
      continue
    }
    i += 1
  }
  return null
}

/** Node 执行点解析：跳过注释/字符串，只认裸 gate('file.mjs') 调用。 */
const parseNodeExecutionSites = (text) => {
  const out = new Set()
  const ident = (ch) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
  for (let i = 0; i < text.length;) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (text[i] === '`') {
      const template = readTemplate(text, i)
      if (template !== null) {
        for (const expression of template.expressions) {
          for (const name of parseNodeExecutionSites(expression)) out.add(name)
        }
        i = template.end
      } else i += 1
      continue
    }
    if (text[i] === "'" || text[i] === '"') {
      const literal = readQuoted(text, i)
      i = literal?.end ?? i + 1
      continue
    }
    if (text.startsWith('gate', i) && !ident(text[i - 1]) && !ident(text[i + 4]) && text[i - 1] !== '.') {
      let j = i + 4
      while (/\s/.test(text[j] ?? '')) j += 1
      if (text[j] === '(') {
        j += 1
        while (/\s/.test(text[j] ?? '')) j += 1
        const literal = readQuoted(text, j)
        if (literal !== null) {
          j = literal.end
          while (/\s/.test(text[j] ?? '')) j += 1
          if (text[j] === ')' && /^(?:check-[a-z0-9-]+\.mjs|elf-check\.mjs)$/.test(literal.value)) out.add(literal.value)
        }
      }
    }
    i += 1
  }
  return out
}

/** 执行点解析：只认真实 gate(...) 调用或 PowerShell 的 node 命令行。 */
const parseExecutionSites = (text, isNode) => {
  if (isNode) return parseNodeExecutionSites(text)
  const out = new Set()
  for (const m of text.matchAll(/^\s*(?:\$\w+\s*=\s*)?node\s+[^\n]*?scripts[\\/](check-[a-z0-9-]+\.mjs|elf-check\.mjs)/gm)) out.add(m[1])
  return out
}

/** SKIP 发射点判据：只认作为代码语句出现的字符串字面量 console.log/error。 */
const emitsSkip = (line) => /^\s*console\.(?:log|error)\(\s*[`'"]\s*(?:FAIL\s+)?SKIP/.test(line)

// 布局无关解析：协调仓根用 dsh-mobile-apk/...；apk 自包含根落到同名相对路径。
const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  const hit = cands.find((c) => existsSync(join(ROOT, c)))
  return hit ? join(ROOT, hit) : null
}
const readIf = (rel) => { const p = resolveRepoPath(rel); return p === null ? null : readFileSync(p, 'utf8') }

// ── 1. 声明集合 vs 实际文件 vs 两条链 ───────────────────────────────────────
const invokedIn = (rel) => {
  const text = readIf(rel)
  if (text === null) return null
  // 兼容两种写法：'check-x.mjs'（node 侧数组/helper）与 "scripts\check-x.mjs"（PowerShell 调用）。
  return parseInvoked(text)
}
/**
 * 执行点解析（0.14.2 实修）：只认「真的会 spawn 这个门禁」的写法，不认声明数组里的字符串字面量。
 *
 * 为什么必须与 invokedIn() 分开：上面那个宽松正则会把 GATE_SCRIPTS 声明数组里的 'check-x.mjs'
 * 也算成「调用过」，于是下面「调用声明集合的每一项」这条断言对 build-apk.mjs **自我满足**——
 * 声明了却没接线照样判绿。本轮实测：build-apk.mjs 声明 37 项、真实执行 36 项，差的正是新加的
 * check-dead-tokens.mjs（只登记未接线），而旧断言 PASSED。修法 = 反向断言必须建立在「执行点」之上，
 * 而不是「文件里出现过这个名字」。
 *
 * 形态只取本仓两条链的实际写法，不做泛化猜测：
 *   - build-apk.mjs（node）：gate('check-x.mjs') 调用点（数组字面量没有 gate(...) 包裹，天然排除）
 *   - build-apk-013.ps1（pwsh）：行首（可带 $var =）node ... scripts\check-x.mjs，跳过注释行
 * 反向断言**只针对 GATE_SCRIPTS 声明清单项**；两条链上另有若干在条件分支内调用的门禁
 * （elf-check / runtime-assets / file-modes / 逐 ABI 段等），不属声明清单，一律不纳入，
 * 避免把合法的分支调用误判成未接线。
 */
const executionSites = (rel, textOverride) => {
  const text = textOverride === undefined ? readIf(rel) : textOverride
  if (text === null) return null
  return parseExecutionSites(text, rel.endsWith('.mjs'))
}

const NODE_CHAIN = 'scripts/build-apk.mjs'
const PWSH_CHAIN = 'scripts/build-apk-013.ps1'
/** 判别力自测，覆盖声明/提及/真实执行点/SKIP 发射点的正反边界。 */
const selfTest = (silent) => {
  const fails = []
  let checks = 0
  const t = (label, ok, detail) => {
    checks += 1
    if (!ok) fails.push(label + (detail === undefined ? '' : ' -> ' + detail))
    else if (!silent) console.log('PASS  [self-test] ' + label)
  }

  t('声明提取认单引号对象项',
    parseDeclared("const G = [{ script: 'check-a.mjs' }, { script: 'check-b.mjs' }]").join(',') === 'check-a.mjs,check-b.mjs')
  t('声明提取不吃双引号或裸字符串', parseDeclared('{ script: "check-a.mjs" }').length === 0)

  const declarationOnly = "const GATE_SCRIPTS = [\n  'check-a.mjs',\n  'check-b.mjs',\n]\n"
  t('宽松提及扫描可发现声明字面量', parseInvoked(declarationOnly).length === 2)
  t('执行点扫描不把声明字面量当成运行', executionSites(NODE_CHAIN, declarationOnly).size === 0)
  t('Node gate 单引号调用是执行点', [...executionSites(NODE_CHAIN, "gate('check-a.mjs')")].includes('check-a.mjs'))
  t('Node gate 双引号调用是执行点', [...executionSites(NODE_CHAIN, 'gate("check-b.mjs")')].includes('check-b.mjs'))
  t('Node 行注释不是执行点', executionSites(NODE_CHAIN, "// gate('check-a.mjs')").size === 0)
  t('Node 块注释不是执行点', executionSites(NODE_CHAIN, "/* gate('check-a.mjs') */").size === 0)
  t('Node 字符串提及不是执行点', executionSites(NODE_CHAIN, 'const note = "gate(\'check-a.mjs\')"').size === 0)
  t('Node 模板文本提及不是执行点', executionSites(NODE_CHAIN, '`gate(\'check-a.mjs\')`').size === 0)
  t('Node 模板插值中的调用是执行点', [...executionSites(NODE_CHAIN, '`${gate("check-a.mjs")}`')].includes('check-a.mjs'))
  t('Node 模板插值中的字符串提及不是执行点', executionSites(NODE_CHAIN, '`${"gate(\'check-a.mjs\')"}`').size === 0)
  t('Node 数组索引不算执行点', executionSites(NODE_CHAIN, 'GATE_SCRIPTS[0]').size === 0)
  t('Node 无引号变量不算执行点', executionSites(NODE_CHAIN, 'gate(name)').size === 0)

  t('PowerShell 行首 node 调用是执行点',
    [...executionSites(PWSH_CHAIN, 'node "$PSScriptRoot\\scripts\\check-a.mjs"')].includes('check-a.mjs'))
  t('PowerShell 赋值接 node 调用是执行点',
    [...executionSites(PWSH_CHAIN, '$r = node scripts/check-b.mjs --x')].includes('check-b.mjs'))
  t('PowerShell 注释不是执行点', executionSites(PWSH_CHAIN, '# node scripts\\check-a.mjs').size === 0)
  t('PowerShell 字符串提及不是执行点', executionSites(PWSH_CHAIN, 'Write-Host "see scripts\\check-a.mjs"').size === 0)

  // Split the synthetic call so this file does not make its own SKIP scanner match a test fixture.
  const sample = (...parts) => parts.join('')
  t('SKIP 计数行被识别', emitsSkip(sample('console.', 'log(', "'SKIP(#1) test'")))
  t('未计数 SKIP 行也被识别', emitsSkip(sample('console.', 'log(', "'SKIP test'")))
  t('FAIL 前缀 SKIP 行被识别', emitsSkip(sample('console.', 'error(', "'FAIL SKIP test'")))
  t('普通注释提及 SKIP 不算发射点', !emitsSkip('// mentions SKIP'))
  t('注释中的 console.log 不是发射点', !emitsSkip("// console.log('SKIP test')"))
  t('console.warn 不在当前审计面', !emitsSkip("console.warn('SKIP test')"))
  return { fails, checks }
}

if (argv.includes('--self-test')) {
  const { fails: stFails, checks } = selfTest(false)
  if (stFails.length > 0) {
    console.error('CHECK-GATE-SKIPS SELF-TEST FAILED（' + stFails.length + ' 项）：' + stFails.join('；'))
    process.exit(1)
  }
  console.log('CHECK-GATE-SKIPS SELF-TEST PASSED（' + checks + ' 项判别力断言）')
  process.exit(0)
}

// 正常模式也先静默自证，避免判据自满足缺陷只靠人工记得传 --self-test。
{
  const { fails: stFails } = selfTest(true)
  if (stFails.length > 0) {
    console.error('CHECK-GATE-SKIPS FAILED：判据自证不通过（' + stFails.length + ' 项）—— ' + stFails.join('；'))
    process.exit(1)
  }
}

const aggText = readIf('scripts/check-release-gates.mjs')
if (aggText === null) { console.error('CHECK-GATE-SKIPS FAILED：缺 scripts/check-release-gates.mjs'); process.exit(2) }
const declared = parseDeclared(aggText)
check('声明集合非空', declared.length > 0, 'gates=' + declared.length)
const missingFiles = declared.filter((g) => !existsSync(join(SCRIPTS, g)))
check('声明集合里的门禁全部在场', missingFiles.length === 0, '缺: ' + missingFiles.join(', '))
const CHAINS = ['scripts/build-apk-013.ps1', 'dsh-mobile-apk/scripts/build-apk.mjs']
const declaredSet = new Set(declared)
for (const rel of CHAINS) {
  const invoked = invokedIn(rel)
  if (invoked === null) { check('构建链在场: ' + rel, false); continue }
  check('构建链在场: ' + rel, true)
  // 声明集合必须被本链**全覆盖**；链上多出来的长驻门禁（overlay/mounts/file-modes/third-party/
  // secrets/elf）不在「本迭代新增声明集合」里，属既有面——列出告警不判红（ST-31 的清单化产物）。
  const extras = invoked.filter((g) => !declaredSet.has(g) && g !== 'check-release-gates.mjs')
  if (extras.length > 0) console.log('WARN  ' + rel + ' 另有声明集合外的长驻门禁（既有面）: ' + extras.join(', '))
  const notInvoked = declared.filter((g) => !invoked.includes(g))
  check(rel + ' 调用声明集合的每一项（' + declared.length + ' 项）', notInvoked.length === 0, '未接线: ' + notInvoked.join(', '))
  // ── 反向断言（0.14.2 实修）：声明集合每一项都必须在**执行点**被真实调用 ──────────────────
  // 旧断言只做「被调用的 ⊆ 声明的」，抓不到「声明了却没接线」；而 invokedIn() 的宽松正则又会把声明
  // 数组本身当成调用证据，使该断言对 build-apk.mjs 恒真。此处改用 executionSites()，两个方向都堵。
  const exec = executionSites(rel)
  if (exec === null) { check('执行点可解析: ' + rel, false); continue }
  const declaredButNotExecuted = declared.filter((g) => !exec.has(g))
  check(rel + ' 声明集合每一项都有真实执行点（反向断言，' + declared.length + ' 项）',
    declaredButNotExecuted.length === 0,
    '只登记未接线: ' + declaredButNotExecuted.join(', '))
}

// ── 2. SKIP 纪律（逐脚本静态审计）───────────────────────────────────────────
// 递归覆盖 scripts/ 全树（原先只列顶层）：来源审计链的 check-*.mjs 全部在 scripts/source-build/，
// 旧实现下它们不在审计面内——将来新增一道「拿不到产物就 SKIP」的来源链门禁，其未计数的 SKIP
// 不会被抓，发布链 SKIP=0 的口径对来源面也就失效。返回相对 SCRIPTS 的路径（便于报出子目录）。
const collectGateFiles = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
  const rel = prefix ? prefix + '/' + entry.name : entry.name
  if (entry.isDirectory()) return collectGateFiles(join(dir, entry.name), rel)
  return entry.name.startsWith('check-') && entry.name.endsWith('.mjs') ? [rel] : []
})
const gateFiles = collectGateFiles(SCRIPTS).sort()
const skipAudit = []
for (const file of gateFiles) {
  const text = readFileSync(join(SCRIPTS, file), 'utf8')
  const lines = text.split('\n')
  // 只认「字符串字面量以 SKIP 开头」的发射点：审计/门禁文案里提到 SKIP 不算（否则本脚本自命中）。
  const skipLines = lines.filter(emitsSkip)
  if (skipLines.length === 0) { skipAudit.push({ file, sites: 0, counted: true }); continue }
  const hasSummary = /SKIP=/.test(text)
  const uncounted = skipLines.filter((l) => !/#/.test(l) && !/SKIP=/.test(l))
  const ok = hasSummary && uncounted.length === 0
  skipAudit.push({ file, sites: skipLines.length, summary: hasSummary, uncounted: uncounted.length, counted: ok })
  check('SKIP 计数: ' + file + '（' + skipLines.length + ' 处）', ok,
    '汇总 SKIP= ' + (hasSummary ? '在场' : '缺席') + '；未计数行 ' + uncounted.length
      + (uncounted.length ? '：' + uncounted[0].trim().slice(0, 90) : ''))
}

// ── 3. 发布链 SKIP=0 ───────────────────────────────────────────────────────
for (const rel of ['scripts/build-release.ps1', 'dsh-mobile-apk/scripts/build-release.ps1']) {
  const text = readIf(rel)
  if (text === null) { check('发布链在场: ' + rel, false); continue }
  check(rel + ' 以 --run --require 调聚合入口（发布链 SKIP=0）',
    /check-release-gates\.mjs/.test(text) && /--run\b[\s\S]{0,80}--require/.test(text),
    '缺 --require：发布链会以 SKIP 结案')
}
const strictWhitelist = ["'check-snapshot-fingerprint.mjs'", "'check-perf-instrumentation.mjs'", "'check-snapshot-secrets.mjs'", "'check-contract.mjs'", "'check-tool-output-schema.mjs'", "'check-dead-tokens.mjs'", "'check-mcp-client-deps.mjs'"]
const strictPropagated = /argvFor\.push\('--require'\)/.test(aggText) && strictWhitelist.every((lit) => aggText.includes(lit))
check('聚合入口对支持 --require 的门禁传严格档（全白名单，' + strictWhitelist.length + ' 项）', strictPropagated)

if (argv.includes('--list')) {
  console.log('== 门禁清单（声明 ' + declared.length + ' 项）')
  for (const g of declared) console.log('   ' + g.padEnd(34) + (invokedIn(CHAINS[0]).includes(g) ? 'local' : '     ') + ' ' + (invokedIn(CHAINS[1]).includes(g) ? 'cloud' : ''))
  console.log('== SKIP 审计')
  for (const a of skipAudit) console.log('   ' + a.file.padEnd(34) + 'sites=' + a.sites + (a.counted ? '' : ' UNCCOUNTED'))
  process.exit(failures.length === 0 ? 0 : 1)
}

if (failures.length > 0) {
  console.error('CHECK-GATE-SKIPS FAILED（' + failures.length + ' 项）：' + failures.join('；'))
  process.exit(1)
}
console.log('CHECK-GATE-SKIPS PASSED（声明 ' + declared.length + ' 项门禁；SKIP 审计 ' + gateFiles.length + ' 个脚本；发布链 --require 在场）')
