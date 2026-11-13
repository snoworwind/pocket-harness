#!/usr/bin/env node
// check-global-agents.mjs — 出厂全局指令基线（scripts/global-AGENTS.md）内容门禁。
//
// 守两件事（判据实现唯一来源 = scripts/source-build/global-agents-policy.mjs）：
//   1. 正文仍是一份可用的基线（非空、有必需锚点、不超注入预算）；
//   2. 正文不含本机私有标记 / 凭据前缀 / emoji（它会随安装包分发给每一个用户）。
//
// 用法：
//   node scripts/check-global-agents.mjs              # 校验仓库里的基线
//   node scripts/check-global-agents.mjs --file <p>   # 校验指定文件（调试用）
//   node scripts/check-global-agents.mjs --self-test  # 无仓库依赖的判别力自检
// 退出码：0 = 通过；1 = 检出问题；2 = 用法/前置错误。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateGlobalAgents } from './source-build/global-agents-policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const fileOf = (args) => {
  const i = args.indexOf('--file')
  return i >= 0 ? args[i + 1] : undefined
}

/** 判别力自检：一条通过的样本 + 每条判据各一条受控负控。 */
function selfTest() {
  const good = [
    '<!-- dsh-mobile-factory-baseline -->',
    '# 基线',
    '本文件随安装包发布，升级时整份替换。',
    'Node 在 /opt/node，引擎在 /opt/dsh，用户写 $HOME。',
    '主运行时是 Debian/glibc，apt 数据保留。',
    '共享存储放 .nomedia。',
    '自己的约定写 ~/.agents/AGENTS.md，项目级写 AGENTS.local.md。',
  ].join('\n')

  // 凭据形态的样本运行时拼接，避免源码出现连续密钥/token 字面量（docs-hygiene 会扫自己）。
  const tokenShaped = ['gho', 'abcdefghijklmnop'].join('_')

  const cases = [
    { label: '正样本', text: good, expectPass: true },
    { label: '空正文', text: '   \n', expectPass: false },
    { label: '缺必需锚点', text: good.replace('/opt/dsh', '未指定引擎目录'), expectPass: false },
    { label: '缺出厂标记', text: good.replace('<!-- dsh-mobile-factory-baseline -->\n', ''), expectPass: false },
    { label: '无一级标题', text: good.replace('# 基线\n', ''), expectPass: false },
    { label: '含应用绝对路径', text: good + '\n见 /data/data/com.example/files/usr\n', expectPass: false },
    { label: '含个人账号名', text: good + '\n见 snoworwind 的仓库\n', expectPass: false },
    { label: '含代理端口', text: good + '\n代理走 127.0.0.1:7897\n', expectPass: false },
    { label: '含 token 形态', text: good + '\n' + tokenShaped + '\n', expectPass: false },
    { label: '含 emoji', text: good + '\n注意⚠️\n', expectPass: false },
    { label: '超预算', text: good + '\n' + 'x'.repeat(13 * 1024), expectPass: false },
  ]

  let failed = 0
  for (const c of cases) {
    const problems = validateGlobalAgents(c.text, c.label)
    const passed = problems.length === 0
    if (passed !== c.expectPass) {
      failed += 1
      console.error('FAIL[self-test] ' + c.label + ': expected ' + (c.expectPass ? 'pass' : 'fail')
        + ', got ' + (passed ? 'pass' : 'fail: ' + problems[0]))
    }
  }
  if (failed > 0) {
    console.error('GLOBAL_AGENTS_SELF_TEST_FAILED ' + failed + '/' + cases.length)
    process.exit(1)
  }
  console.log('global-agents self-test passed: ' + cases.length + ' cases (1 positive, ' + (cases.length - 1) + ' negative controls)')
}

if (argv.includes('--self-test')) {
  selfTest()
} else if (argv.includes('--help') || argv.includes('-h')) {
  console.error('用法: node scripts/check-global-agents.mjs [--file <path>] [--self-test]')
  process.exit(2)
} else {
  const file = resolve(fileOf(argv) ?? join(ROOT, 'scripts', 'global-AGENTS.md'))
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    console.error('FAIL[read]: 读不到出厂基线 ' + file + ': ' + error.message)
    console.error('GLOBAL_AGENTS_CHECK_FAILED')
    process.exit(2)
  }
  const problems = validateGlobalAgents(text, file)
  if (problems.length > 0) {
    for (const problem of problems) console.error('FAIL: ' + problem)
    console.error('GLOBAL_AGENTS_CHECK_FAILED')
    process.exit(1)
  }
  console.log('global-agents baseline OK: ' + Buffer.byteLength(text.trim(), 'utf8') + ' bytes, '
    + file)
}
