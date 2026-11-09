import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { FORBIDDEN_PATTERNS, MAX_BYTES, REQUIRED_SNIPPETS, validateGlobalAgents } from './global-agents-policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(dirname(dirname(HERE)), 'scripts', 'global-AGENTS.md')

const minimum = [
  '<!-- dsh-mobile-factory-baseline -->',
  '# 基线',
  '本文件随安装包发布。',
  '不写 $PREFIX，写 $HOME。',
  'process.execPath 是 linker64。',
  '共享存储放 .nomedia。',
  '自己的约定写 ~/.agents/AGENTS.md，项目级写 AGENTS.local.md。',
].join('\n')

test('仓库里的出厂基线通过全部判据', () => {
  const text = readFileSync(BASELINE, 'utf8')
  assert.deepEqual(validateGlobalAgents(text, BASELINE), [])
})

test('每条必需锚点缺一即判红（逐条负控）', () => {
  for (const { snippet } of REQUIRED_SNIPPETS) {
    const broken = minimum.replace(snippet, '（已删除）')
    assert.notEqual(broken, minimum, `样本里应包含 ${snippet}`)
    assert.ok(validateGlobalAgents(broken).some((p) => p.includes('缺少必需内容')), `缺 ${snippet} 时应判红`)
  }
})

// 每条禁止模式一条**专属样本**：样本必须命中该模式本身（而不是碰巧被别的模式抓到）。
// 新增禁止模式而未补样本时，下面的覆盖断言会判红——这正是我们想要的维护压力。
const SAMPLE_BY_PATTERN = new Map([
  ['\\/data\\/data\\/', '见 /data/data/com.example/files'],
  ['\\/data\\/user\\/\\d+\\/', '见 /data/user/0/com.example/files'],
  ['com\\.termux', '包名 com.termux'],
  ['\\/storage\\/emulated\\/0\\/', '见 /storage/emulated/0/tmp'],
  ['\\b7897\\b', '代理 127.0.0.1:7897'],
  ['env-backup', '工作区 env-backup'],
  ['opt\\/INDEX\\.md', '台账 ~/.dsh/opt/INDEX.md'],
  ['snoworwind', '账号 snoworwind'],
  ['\\bg(?:ho|hp|hs)_[A-Za-z0-9]{8,}', 'gho_abcdefghijklmnop'],
  ['\\bsk-[A-Za-z0-9]{8,}', 'sk-abcdefghijkl'],
  ['-----BEGIN [A-Z ]*PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----'],
  ['[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]', '注意⚠️'],
])

test('每条禁止模式各有一条专属受控负控', () => {
  assert.equal(SAMPLE_BY_PATTERN.size, FORBIDDEN_PATTERNS.length,
    '禁止模式与测试样本必须一一对应（新增模式要补样本）')
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    const sample = SAMPLE_BY_PATTERN.get(re.source)
    assert.ok(sample, '缺少样本: ' + re.source + '（' + why + '）')
    assert.ok(re.test(sample), '样本必须命中它自己的模式: ' + re.source + ' <- ' + sample)
    const problems = validateGlobalAgents(minimum + '\n' + sample)
    assert.ok(problems.some((p) => p.includes(JSON.stringify(sample.match(re)[0]))),
      '样本 ' + sample + ' 应被该模式判红')
  }
})

test('空正文、无标题、超预算均判红', () => {
  assert.ok(validateGlobalAgents('').length > 0)
  assert.ok(validateGlobalAgents('\n\n').length > 0)
  assert.ok(validateGlobalAgents('没有标题\n' + minimum).length > 0)
  const oversized = minimum + '\n' + 'x'.repeat(MAX_BYTES)
  assert.ok(validateGlobalAgents(oversized).some((p) => p.includes('超过注入预算上限')))
})

test('正样本无问题（正对照，防止判据恒红）', () => {
  assert.deepEqual(validateGlobalAgents(minimum), [])
})
