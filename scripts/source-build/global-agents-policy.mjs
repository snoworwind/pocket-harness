/**
 * 出厂全局指令基线（`scripts/global-AGENTS.md` → 设备 `home/.dsh/AGENTS.md`）的内容策略。
 *
 * 为什么需要一份「策略」而不是随手写个 md：
 *   - 这个文件会**注入每一个用户的每一个会话**，写得越长，所有会话的上下文成本越高；
 *   - 它又会**打进每一个用户的安装包**，本机私有事实（个人路径、代理端口、设备型号、
 *     备份目录、账号名）一旦混进去就是随包分发的信息泄漏，而且很难在事后发现；
 *   - 它还是**工厂件**（升级整份替换），所以必须只写「对所有安装都成立」的结论——
 *     带具体版本号/装机状态的断言会随升级失真。
 *
 * 判据分两类，都是零启发式的：
 *   - 必须命中：文件确实在讲本应用的两层运行时与环境事实（防止被换成空壳/占位后静默通过）；
 *   - 禁止出现：本机私有标记 + 密钥前缀 + emoji（仓库铁律）。
 *
 * 纯函数、无 I/O，构建链（`scripts/build-snapshot-013.mjs`）与门禁脚本
 * （`scripts/check-global-agents.mjs`）共用这一份判据，避免两处漂移。
 */

/** 上限：注入每个会话的成本。当前正文约 4 KB，留三倍余量给后续补充，超出即需评审。 */
export const MAX_BYTES = 12 * 1024

/** 出厂标记：迁移判据靠它区分「用户手写的历史文件」与「旧版本工厂件」。 */
export const FACTORY_BASELINE_SENTINEL = '<!-- dsh-mobile-factory-baseline -->'

/** 必须出现的锚点：证明正文确实是「两层运行时 + 环境事实 + 约定归属」这份基线。 */
export const REQUIRED_SNIPPETS = [
  { snippet: FACTORY_BASELINE_SENTINEL, why: '出厂标记：Shell 侧靠它判断这个文件是不是工厂件（旧版工厂件不得被当成用户笔记迁移）' },
  { snippet: '本文件随安装包发布', why: '必须声明自己是工厂件（升级替换），否则用户会把它当长期配置来改' },
  { snippet: '$PREFIX', why: '必须点名出厂运行时目录，这是「绝不写入」红线的对象' },
  { snippet: '$HOME', why: '必须点名用户面目录，否则没有可写的对照面' },
  { snippet: 'linker64', why: 'node 不能派生子进程这条判据的具体形态' },
  { snippet: '.nomedia', why: '共享存储媒体索引的规避手段' },
  { snippet: '~/.agents/AGENTS.md', why: '必须给出「用户自己的全局约定写哪里」，否则用户只能改工厂件' },
  { snippet: 'AGENTS.local.md', why: '必须给出项目级个人覆盖的位置' },
]

/**
 * 禁止出现的本机私有标记 / 凭据前缀 / emoji。
 *
 * 每条都来自本机 `~/.dsh/AGENTS.md` 与设备 skill 里真实出现过的「私有事实」，
 * 它们对别的安装不成立：写进去 = 误导 + 随包分发。
 */
export const FORBIDDEN_PATTERNS = [
  { re: /\/data\/data\//, why: '应用私有目录的绝对路径（含包名），每台设备的 uid 与包名上下文不同' },
  { re: /\/data\/user\/\d+\//, why: '同上，另一种写法' },
  { re: /com\.termux/, why: '构建设备的运行时包名，与本应用无关' },
  { re: /\/storage\/emulated\/0\//, why: '本机共享存储的绝对路径（各设备路径不同，且属个人目录）' },
  { re: /\b7897\b/, why: '本机代理端口，属个人网络环境' },
  { re: /env-backup/, why: '本机的环境备份工作区，出厂安装里不存在' },
  { re: /opt\/INDEX\.md/, why: '本机的软件台账文件，出厂安装里不存在（新用户照做会找不到文件）' },
  { re: /snoworwind/, why: '个人账号名' },
  { re: /\bg(?:ho|hp|hs)_[A-Za-z0-9]{8,}/, why: 'GitHub token 形态' },
  { re: /\bsk-[A-Za-z0-9]{8,}/, why: '模型服务 key 形态' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥头' },
  {
    re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u,
    why: '仓库铁律禁 emoji（提交信息、文档、标签一律不用）',
  },
]

/**
 * 校验出厂基线正文。
 *
 * @param {string} text 文件内容（UTF-8 解码后的全文）
 * @param {string} [label] 报错用的来源标签
 * @returns {string[]} 问题列表；空数组 = 通过
 */
export function validateGlobalAgents(text, label = 'scripts/global-AGENTS.md') {
  const problems = []
  if (typeof text !== 'string') return [`${label}: 无法读取正文（非字符串）`]
  const body = text.trim()
  if (body.length === 0) return [`${label}: 正文为空`]

  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_BYTES) {
    problems.push(`${label}: 正文 ${bytes} 字节，超过注入预算上限 ${MAX_BYTES} 字节`)
  }
  if (!body.startsWith(FACTORY_BASELINE_SENTINEL)) {
    problems.push(`${label}: 首行必须是出厂标记 ${JSON.stringify(FACTORY_BASELINE_SENTINEL)}（Shell 侧迁移判据依赖它）`)
  }
  const headLines = body.split('\n').slice(0, 4)
  if (!headLines.some((line) => line.startsWith('# '))) {
    problems.push(`${label}: 前 4 行内必须有以 "# " 开头的一级标题`)
  }
  for (const { snippet, why } of REQUIRED_SNIPPETS) {
    if (!body.includes(snippet)) {
      problems.push(`${label}: 缺少必需内容 ${JSON.stringify(snippet)}（${why}）`)
    }
  }
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    const match = body.match(re)
    if (match) {
      problems.push(`${label}: 含设备私有或禁止的内容 ${JSON.stringify(match[0])}（${why}）`)
    }
  }
  return problems
}
