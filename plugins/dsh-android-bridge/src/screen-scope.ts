import { readFileSync } from 'node:fs'

/** User-owned, stable screen aliases exposed to model-facing Android tools. */
export type ScreenId = string
export type UserScreenScope = 'virtual-only' | 'real-only' | 'all'

export const DEFAULT_SCREEN_SCOPE: UserScreenScope = 'virtual-only'
export const REAL_SCREEN_ID = 'real'
export const VIRTUAL_SCREEN_ID = 'virtual-1'
export const REAL_DISPLAY_ID = 0

/** 规格 §2.1：壳侧分配 1..N 的 `virtual-N`；本版上限 1 屏。 */
const VIRTUAL_SCREEN_PATTERN = /^virtual-([1-9][0-9]{0,2})$/

/** `virtual-N` 编号；非虚拟别名返回 null。 */
export function virtualScreenOrdinal(screenId: string | undefined): number | null {
  const match = VIRTUAL_SCREEN_PATTERN.exec(screenId ?? '')
  return match === null ? null : Number(match[1])
}

export function isVirtualScreenId(screenId: string | undefined): boolean {
  return virtualScreenOrdinal(screenId) !== null
}

const SHELL_SCREEN_SCOPE_PREFS_DEFAULT = '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh_screen_scope.xml'

/** Result returned before a tool reads pixels, a UI tree, or dispatches an input action. */
export type ScreenAccessDecision =
  | { ok: true; screenId: ScreenId; displayId: number; scope: UserScreenScope }
  | { ok: false; reason: 'screen-not-found' | 'screen-out-of-scope' | 'screen-not-ready'; guidance: string; scope: UserScreenScope; screenId: string }

/** review C11：调用方可提供原生注册表解析出的虚拟屏**动态** displayId（alias→id 回填）。 */
export interface ScreenAccessOptions {
  virtualDisplayId?: number | null
  /**
   * 块G F2：壳侧虚拟屏注册表当前登记的 displayId 集合（raw shell 命令的显式 `-d <id>` 核对用）。
   * 缺席/不可达 → 视为空集（fail-closed：不凭命令里的数字自证目标屏属虚拟屏）。
   */
  virtualDisplayIds?: readonly number[] | ReadonlySet<number>
  /**
   * 块G F6：**SurfaceFlinger token** ↔ 产品别名的配对（`screencap -d` 实际吃的 id 空间）。
   *
   * 为什么需要它：`screencap -d <DisplayManager displayId>` 对虚拟屏**必然失败**
   * （设备实测 Status -2），只有传 SF token 才出图；而 SF token 既不在 `virtualDisplayIds` 里、
   * 又超出 2^53/2^63 无法数值化。故必须并存这条字符串映射。
   * 同时必须给 [virtualAliases]——**只有配对别名确属已注册虚拟屏的 token 才可放行**，
   * 真实屏的 SF token 一律拒绝。
   */
  sfVirtualDisplays?: readonly { alias: string; token: string }[]
  /** 当前已注册的虚拟屏**别名**集合（与 sfVirtualDisplays 联合使用，缺一即 fail-closed）。 */
  virtualAliases?: readonly string[] | ReadonlySet<string>
}

/**
 * a11y 承载的、**按设计作用于设备屏内容**的 op——执行点范围复查的分类真源。
 *
 * 0.14.1 块G（F4）口径更正：本常量是**按 op 名**的分类，回答「这个 op 通常是否读写某块设备屏
 * 的内容」，**不是**「这一次调用作用于真实屏」。后者必须由 `args.screenId` 经注册表解析出的
 * **目标屏**判定（见 index.ts 的 controlExec 执行点与 decideScreenAccess）。把前者当成后者，
 * 在 virtual-only + 已建虚拟屏时必然误判，并产出「范围允许 virtual-1 却说不许访问真实屏」的
 * 自相矛盾报文（用户实报；该报文逐字来自 index.ts 执行点的硬编码文案）。
 *
 * 两类刻意不在列：
 *   - `state`：只回代次/失效标记（元数据），不含屏幕内容（U-3 约束的是内容面）；
 *   - `webSnapshot` / `webAction`：目标是**壳自有 WebView**（DSH 自己的 Web UI），不带也不认
 *     `screenId`，与设备屏无关。按 op 名归为「设备屏内容 op」会让 `android_web_dump` 在
 *     virtual-only 下被整体误拒（块G F4b 同源论断：过度拦截与「范围门禁自相矛盾」是同一类缺陷）。
 * browser\* 操作隔离 BrowserHost（第二 WebView），vd\* 管理面不在此列；其中写屏内容的
 * `vdInput` 由 `controlExec` 单独按虚拟目标校验，并由壳侧 `VdisplayController.input` 再次复核。
 */
export const REAL_SCREEN_CONTROL_OPS: readonly string[] = [
  'snapshot', 'click', 'longClick', 'setText', 'scroll', 'global', 'screenshot', 'nodeText',
]

/** 该 op 是否读写**设备屏**内容（review C11：controlExec 执行点据此复查范围）。 */
export function controlOpNeedsRealScreen(op: string): boolean {
  return REAL_SCREEN_CONTROL_OPS.includes(op)
}

// ── 目标屏参数：全链路唯一的取值口 ────────────────────────────────────────────────
//
// 各命令的有效拼写由 SCREEN_COMMAND_FAMILIES 分别限定；取值**保留
// 原始十进制串、绝不数值化**：`screencap -d` 吃的是 SurfaceFlinger display token，
// 设备实测虚拟屏形如 `11529215046816944610` —— 它 > 2^53（JS Number 安全整数上界）且
// > 2^63-1（Kotlin Long 上界）。任何数值化都会把它变成 `...944000`（末位失真），
// 于是「设备上能出图的 token」与「命令里写的 token」不再相等，判定与取图必然错位。
// （主屏 token `4619827820427265280` 同样 > 2^53。）
//
// 空白类一律用**显式 ASCII 集**（`[ \t]` / `\s` 的跨语言陷阱见 N-5：JS 的 `\s` 含 Unicode
// 空白、Java 的 `\s` 只含 ASCII ⇒ 两侧正则「逐字相同」却不等价）。Kotlin 侧同名实现必须用
// 同一集合；跨语言 fixture 锁死等价性。

/** 一条 `-d/--display/--display-id` 目标屏参数（值保留原样字符串）。 */
export interface DisplayOption {
  /** 命中的拼写（`-d` / `--display` / `--display-id`）。 */
  flag: string
  /** 原始十进制串（未数值化）。 */
  value: string
}

/** 扫描命令里出现的全部目标屏参数（含三种拼写，值原样字符串）。 */
export function displayOptionsIn(text: string): DisplayOption[] {
  const out: DisplayOption[] = []
  for (const m of text.matchAll(/(?:^|[ \t])(-d|--display|--display-id)[ \t=]+(\d+)/g)) {
    out.push({ flag: m[1], value: m[2] })
  }
  return out
}

/**
 * ADB shell 命令里显式指定的目标 display id（`-d <id>` / `--display <id>` / `--display-id <id>`）。
 *
 * 用途（块G F2）：raw shell 面的范围复查不能只做**命令词**匹配——`screencap -d 47` 读的是
 * 虚拟屏 47，与无参 `screencap`（读真实屏 0）根本不是一件事；同罪拒绝会让「用户只给
 * virtual-only」也永远读不到自己的虚拟屏。提取目标 id 后交由调用方与壳侧注册表核对。
 * @returns 命令中出现的 display id；空数组 = 命令没有可核对的目标屏（调用方必须 fail-closed）。
 */
export function adbCommandDisplayIds(command: string): number[] {
  const ids: number[] = []
  for (const value of adbCommandDisplayTokens(command)) {
    const id = Number(value)
    if (Number.isInteger(id)) ids.push(id)
  }
  return ids
}

/**
 * 同上的目标屏参数，但保留原始十进制串、**不做数值化**（理由见本节顶部的 token 值域说明）。
 * @returns 命令中出现的目标屏数字串（原样）；空数组 = 无可核对目标屏。
 */
export function adbCommandDisplayTokens(command: string): string[] {
  const parsed = splitCommandSegments(command)
  if (parsed.unparsed) return []
  return parsed.segments.flatMap((segment) => displayOptionsIn(scopeCommandText(segment) ?? '').map((option) => option.value))
}

// ── 命令段切分：引号感知（§8.3b 洗白绕过的修法） ────────────────────────────────
//
// 缺陷形态（0.14.1 新引入，P0）：判定只看「命令里出现的每个 `-d` 值是否都属于虚拟屏」，
// **不看「整条命令是否只作用于那块屏」**。于是
//   screencap -p -d <虚拟屏 token> /sdcard/a.png; screencap -p /sdcard/real.png
// 里第二段读真实屏，却因第一段的 `-d` 命中而被整体放行（一行参数洗白整行）。
//
// 修法：引号感知切段 + 每一段各自自证。四条不变量：
//   ① 分隔符（`;` `&&` `||` `|` `&` 换行）**只在引号外**切段（引号内的 `|` 是 `grep -E 'a|b'`
//      这类合法形态，误切会把合法命令判成多段）；
//   ② 嵌套执行体（反引号、`$(...)`、`sh -c '<内层>'`）**再切一层**——它们会被 shell 真正执行，
//      不切开就等于放过 `sh -c "screencap -d <token>; input tap 1 2"`；
//   ③ 抽 token / 匹配命令词之前先还原静态参数，引用的数据仍保持一个词；注释与重定向落点
//      不参与认证，每段独立核对（否则别处的 token 会充当洗白凭据）；
//   ④ 引号不闭合（无法解析）一律判**拒**（fail-closed：绝不在看不懂的命令上放行）。

/** 引号感知切段结果。`unparsed` = 引号不闭合等无法解析形态（调用方必须 fail-closed）。 */
export interface CommandSegments {
  /** 顶层命令段 + 全部嵌套执行体（同一个判据逐个过）。 */
  segments: string[]
  unparsed: boolean
}

/** 嵌套执行体再切一层的深度上限（防御构造出来的深嵌套导致栈溢出）。 */
const MAX_NESTING = 4

/** Commands that can execute opaque scripts or stdin; restricted screen scopes cannot inspect their effects. */
const OPAQUE_EXECUTION = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:eval|source|xargs|trap|awk|gawk|mawk|perl|python(?:[0-9.]*)?|node(?:js)?|ruby|php|lua|tclsh|js|alias|hash|read|run-as|runcon|chroot|app_process|dalvikvm|\.)(?:[ \t]|$)|(?:^|[ \t])find[ \t]+[^\n]*[ \t]-(?:exec|ok)(?:dir)?(?:[ \t]|$)|(?:^|[ \t])tar[ \t]+[^\n]*[ \t]--to-command(?:[ =]|$)/i
const SHELL_INTERPRETER = /^(?:[^\s]*\/)?(?:sh|bash|mksh|ash|dash|zsh|busybox|toybox|su)(?=[ \t]|$)/i
const SCREEN_COMMAND_HEAD = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:(?:[^\s]*\/)?(?:screencap|screenrecord|input|uiautomator|wm|dumpsys|am|monkey|cmd[ \t]+(?:activity|window)))(?=[ \t]|$)/i
const SCREEN_COMMAND_WORD = /\b(?:screencap|screenrecord|input|uiautomator|wm|dumpsys|am|monkey|cmd[ \t]+(?:activity|window))\b/i
const COMMAND_LAUNCHER_HEAD = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:command|builtin|exec|env|nohup|nice|timeout|setsid|time|!)(?=[ \t]|$)/i
const SAFE_SHELL_LAUNCHER_HEAD = /^(?:env|command)[ \t]+(?:\/system\/bin\/)?sh[ \t]+-c[ \t]/
const TRUSTED_SHELL_PATH_HEAD = /^\/system\/bin\/sh[ \t]+-c[ \t]/
const SHELL_CONTROL_HEAD = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:if|then|elif|else|fi|while|until|for|select|case|esac|do|done|function|coproc)(?=[ \t]|$)/
// These interfaces can inspect multiple displays and do not have one uniform target selector.
const OPAQUE_DISPLAY_API = /\b(?:cmd[ \t]+window|wm[ \t]+dump-visible-window-views|(?:am|cmd[ \t]+activity)[ \t]+instrument)\b/i
/** Path-based executables may be attacker-written scripts whose screen effects are invisible here. */
const EXECUTABLE_PATH_HEAD = /^[^ \t]*\/[^ \t]*(?=[ \t]|$)/
const COMMAND_GLOB_HEAD = /^[^ \t]*[*?\[]/
/** Search paths, shell startup files and loader hooks can execute code absent from the submitted command. */
const EXECUTION_ENV_OVERRIDE = /(?:^|[ \t])(?:(?:export|declare|typeset|local|readonly)[ \t]+(?:-[A-Za-z]+[ \t]+)*)?(?:PATH|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|ZDOTDIR|LD_[A-Z0-9_]+)[ \t]*=/

function dynamicExpansionCanAffectScreenScope(prefix: string): boolean {
  const bare = stripQuotedText(prefix).trimEnd()
  if (bare.trim().length === 0 || !/[ \t]/.test(bare)) return true
  if (SHELL_C_PAYLOAD.test(bare) || SCREEN_COMMAND_HEAD.test(bare)) return true
  return COMMAND_LAUNCHER_HEAD.test(bare) && SCREEN_COMMAND_WORD.test(bare)
}

/** 反引号段结束位置；`\`` 转义不算结束。返回 -1 = 未闭合。 */
function backtickEnd(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === '`') return i
    i += 1
  }
  return -1
}

/** `$(` 的配对 `)` 位置（内部引号与嵌套括号都计入）。返回 -1 = 未闭合。 */
function parenEnd(text: string, from: number): number {
  let depth = 1
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      while (i < text.length) {
        if (quote === '"' && text[i] === '\\') { i += 2; continue }
        if (text[i] === quote) break
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** Only the actual, fixed `sh -c` launch may donate an inspectable payload. */
const SHELL_C_PAYLOAD = /^[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)[ \t]+)*(?:(?:env|command)[ \t]+)?(?:\/system\/bin\/)?sh[ \t]+-c[ \t]+([\s\S]*)$/

/** Read the first shell word after `-c`, removing the outer shell quoting. Null means ambiguous. */
function shellCommandArgument(text: string): string | null {
  let out = ''
  let quote: "'" | '"' | null = null
  let sawArgument = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quote === null) {
      if (/[ \t\r\n;&|<>]/.test(ch)) break
      if (ch === "'" || ch === '"') {
        quote = ch
        sawArgument = true
        i += 1
        continue
      }
      if (ch === '\\') {
        if (i + 1 >= text.length) return null
        sawArgument = true
        if (text[i + 1] !== '\n') out += text[i + 1]
        i += 2
        continue
      }
      sawArgument = true
      out += ch
      i += 1
      continue
    }
    if (quote === "'" && ch === "'") {
      quote = null
      i += 1
      continue
    }
    if (quote === '"' && ch === '"') {
      quote = null
      i += 1
      continue
    }
    if (quote === '"' && ch === '\\') {
      if (i + 1 >= text.length) return null
      const next = text[i + 1]
      if (next === '$' || next === '`' || next === '"' || next === '\\') out += next
      else if (next === '\n') { /* shell line continuation */ }
      else out += `\\${next}`
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return quote === null && sawArgument ? out : null
}

/**
 * 引号感知地把一条命令切成**可判定段**：顶层段 + 反引号 / `$()` / `sh -c` 的嵌套执行体。
 *
 * 纯函数（无 IO、无全局态），与壳侧 `ShellOps.splitCommandSegments` 同一算法，由跨语言
 * fixture 锁死等价性。
 */
export function splitCommandSegments(command: string): CommandSegments {
  const segments: string[] = []
  let unparsed = false
  const scan = (text: string, depth: number): void => {
    if (depth > MAX_NESTING) { unparsed = true; return }
    let buf = ''
    const flush = (): void => { segments.push(buf); buf = '' }
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\') { buf += text.slice(i, i + 2); i += 2; continue }
      if (ch === "'") {
        const end = text.indexOf("'", i + 1)
        if (end < 0) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        // A quote can be part of the command word (`screen"cap"`) or the command itself
        // (`'screencap'`). Quoted arguments after a command remain ordinary data.
        if (buf.trim().length === 0 || (buf.length > 0 && !/[ \t]$/.test(buf))) unparsed = true
        buf += text.slice(i, end + 1); i = end + 1; continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < text.length) {
          if (text[j] === '\\') { j += 2; continue }
          if (text[j] === '"') break
          // Unlike single quotes, double quotes still expand variables, $(...), and backticks.
          // We cannot prove the resulting command word statically, so narrowed screen scopes fail closed.
          if (text[j] === '$' || text[j] === '`') unparsed = true
          j += 1
        }
        if (j >= text.length) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        if (buf.trim().length === 0 || (buf.length > 0 && !/[ \t]$/.test(buf))) unparsed = true
        buf += text.slice(i, j + 1); i = j + 1; continue
      }
      if (ch === '`') {
        const end = backtickEnd(text, i + 1)
        if (end < 0) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        if (dynamicExpansionCanAffectScreenScope(buf)) unparsed = true
        scan(text.slice(i + 1, end), depth + 1)
        buf += ' '; i = end + 1; continue
      }
      if (ch === '$' && text[i + 1] === '(') {
        const end = parenEnd(text, i + 2)
        if (end < 0) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        if (dynamicExpansionCanAffectScreenScope(buf)) unparsed = true
        scan(text.slice(i + 2, end), depth + 1)
        buf += ' '; i = end + 1; continue
      }
      // Bare parameter expansion can synthesize an executable command (`cmd=screencap; $cmd`).
      if (ch === '$') unparsed = true
      // Process substitution also runs a nested command, but is not represented by `$()`.
      if ((ch === '<' || ch === '>') && text[i + 1] === '(') unparsed = true
      if (ch === ';' || ch === '\n' || ch === '\r') { flush(); i += 1; continue }
      if (ch === '&' || ch === '|') {
        // `&&` / `||` 与单个 `&` / `|` 都是分隔符；两个字符都要吃掉。
        flush()
        i += text[i + 1] === ch ? 2 : 1
        continue
      }
      buf += ch; i += 1
    }
    flush()
  }
  scan(command, 0)
  // `sh -c` 载荷是**再看一层**的入口：它整段都在引号里（`stripQuotedText` 会把它抹掉），
  // 必须用**原文**匹配、再解一层引号把内层当命令扫。工作队列让嵌套的 `sh -c "sh -c …"` 也被展开
  // （载荷是子串，必然收缩；上限 16 层只是防御性护栏）。
  const pending = segments.slice()
  for (let round = 0; pending.length > 0 && round < 16; round += 1) {
    const segment = pending.shift() as string
    const payload = SHELL_C_PAYLOAD.exec(segment)
    if (payload === null) continue
    const inner = shellCommandArgument(payload[1])
    if (inner === null) { unparsed = true; continue }
    if (inner.length === 0) continue
    const before = segments.length
    scan(inner, 1)
    pending.push(...segments.slice(before))
  }
  if (pending.length > 0) unparsed = true
  if (segments.some((segment) => {
    const view = scopeCommandText(segment)
    if (view === null) return true
    const words = view.split(' ')
    let first = 0
    while (first < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first])) first += 1
    const head = words.slice(first).join(' ')
    return OPAQUE_EXECUTION.test(head)
      || head.split(' ')[0] === '__shell_argument__'
      || OPAQUE_DISPLAY_API.test(head)
      || SHELL_CONTROL_HEAD.test(head)
      || COMMAND_GLOB_HEAD.test(head)
      || (EXECUTABLE_PATH_HEAD.test(head) && !TRUSTED_SHELL_PATH_HEAD.test(head))
      || (COMMAND_LAUNCHER_HEAD.test(head) && !(SAFE_SHELL_LAUNCHER_HEAD.test(head) && SHELL_C_PAYLOAD.test(segment)))
      || EXECUTION_ENV_OVERRIDE.test(view)
      || (SHELL_INTERPRETER.test(head) && !SHELL_C_PAYLOAD.test(segment))
  })) unparsed = true
  return { segments, unparsed }
}

/**
 * Decode static shell words while keeping each quoted argument one word.
 * Redirection filenames and comments cannot donate a display selector to the command.
 * Unsupported compound syntax and descriptor redirections fail closed.
 */
function scopeCommandText(text: string): string | null {
  const words: string[] = []
  let word = ''
  let active = false
  let redirect = false
  let quote: "'" | '"' | null = null
  const flush = () => {
    if (!active) return
    if (redirect) redirect = false
    else {
      // A literal argument containing spaces must not become multiple policy words.
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(word)?.[0] ?? ''
      words.push(/[ \t\r\n]/.test(word) ? assignment + '__shell_argument__' : word)
    }
    word = ''
    active = false
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (ch === '\\') {
      if (i + 1 >= text.length) return null
      const next = text[++i]
      if (next === '\n') continue
      if (quote === '"' && !/[$"\\`]/.test(next)) word += '\\'
      word += next
      active = true
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      active = true
      continue
    }
    if (ch === '#' && !active) break
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { flush(); continue }
    if (ch === '<' || ch === '>') {
      if (active && /^[0-9]+$/.test(word)) { word = ''; active = false }
      else flush()
      if (redirect) return null
      if (text[i + 1] === ch) {
        if (ch === '<') return null // A here-document contains another uninspected language.
        i += 1
      }
      if (text[i + 1] === '&' || text[i + 1] === '|' || text[i + 1] === '(' || text[i + 1] === '>') return null
      redirect = true
      continue
    }
    if ('(){};&|'.includes(ch)) return null
    word += ch
    active = true
  }
  if (quote !== null) return null
  flush()
  return redirect ? null : words.join(' ')
}

/**
 * 仅供动态展开前缀检测使用：去掉引用数据并还原反斜杠转义。
 * 真实参数与显示选择器认证使用 scopeCommandText，不能抹掉引用参数的值。
 */
export function stripQuotedText(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      out += i + 1 < text.length ? text[i + 1] : ''
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      while (j < text.length) {
        if (quote === '"' && text[j] === '\\') { j += 2; continue }
        if (text[j] === quote) break
        j += 1
      }
      if (j >= text.length) { out += ' '; i = text.length; continue }
      out += ' '
      i = j + 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 把目标屏参数整体抹成空白（命令词匹配前归一化，使 `input -d 0 tap …` 也进命令词面）。 */
export function stripDisplayOptions(text: string): string {
  return text.replace(/(?:^|[ \t])(?:-d|--display|--display-id)[ \t=]+\d+/g, ' ')
}

// ── 命令词家族：每个家族自带「哪种拼写才算它的目标屏」 ──────────────────────────
//
// 缺陷形态（§8.3，P1）：旧实现是**单个大正则**，`input\s+(?:tap|swipe|…)` 要求动词**紧跟**
// `input`。而 Android CLI 的正式形态是 `input [-d DISPLAY_ID] <command>`（选项在**前**）⇒
// `input -d 0 tap 500 800` 不进命令词面 → 直接放行（读/写真实屏）。
//
// 修法：命令词在**归一化后**（stripDisplayOptions）匹配；并且每个家族各自声明
// **哪些拼写可以认证它的目标屏**——因为 `-d` 并非处处都是 display 参数：
//   `am start -d 5 -n p/.A` 里的 `-d` 是 **Intent data**（不是屏），拿它当目标屏凭据
//   等于给「启动到真实屏」发通行证；`am` 的显示参数是 `--display`。
//
// 命令词面本身**不得缩水**（缩水 = 直接放行真实屏），Kotlin 侧同名表 + fixture 双向锁死。

interface ScreenCommandFamily {
  /** 家族名（诊断与 fixture 用）。 */
  name: string
  /** 归一化文本上的命令词面。 */
  pattern: RegExp
  /**
   * 可作「目标屏认证」的拼写白名单；**空数组 = 该命令没有目标屏参数** ⇒ 在 virtual-only 下
   * 任何命中本家族的命令都无法自证，一律拒绝（无参 `screencap`、`uiautomator dump`、
   * `dumpsys window`、`monkey -p x 1` 都属这一类：它们读的就是**默认屏**）。
   */
  targetFlags: readonly string[]
}


/** 命令词面及各 CLI 实际支持的显示选择器；与 Kotlin 侧同表。 */
const SCREEN_COMMAND_FAMILIES: readonly ScreenCommandFamily[] = [
  { name: 'screencap', pattern: /\bscreencap\b/i, targetFlags: ['-d'] },
  { name: 'screenrecord', pattern: /\bscreenrecord\b/i, targetFlags: ['--display-id'] },
  {
    name: 'input',
    // Input sources and new verbs must not hide this command's screen access.
    pattern: /\binput\b/i,
    targetFlags: ['-d'],
  },
  { name: 'wm', pattern: /\bwm[ \t]+(?:size|density)(?=[ \t]|$)/i, targetFlags: ['-d'] },
  { name: 'wm-unscoped', pattern: /\bwm[ \t]+(?!(?:size|density)(?=[ \t]|$))[^ \t]+/i, targetFlags: [] },
  // `uiautomator dump` 没有目标屏参数：dump 的就是**默认屏**的语义树 ⇒ 无法自证，恒拒。
  { name: 'uiautomator', pattern: /\buiautomator\b/i, targetFlags: [] },
  { name: 'dumpsys', pattern: /\bdumpsys[ \t]+(?:window|display|input)\b/i, targetFlags: [] },
  // `am` / `cmd activity` 的启动显示参数是 `--display`；`-d` 是 Intent data，**不得**作为目标屏凭据（见上）。
  { name: 'am', pattern: /\bam[ \t]+(?:start(?=[ \t]|$)|start-activity(?=[ \t]|$)|start-in-vsync(?=[ \t]|$))/i, targetFlags: ['--display'] },
  { name: 'am-unscoped', pattern: /\bam[ \t]+(?:force-stop|kill|instrument|startservice|start-service|startforegroundservice|startfgservice|start-foreground-service|start-fg-service|broadcast)\b/i, targetFlags: [] },
  { name: 'cmd-activity', pattern: /\bcmd[ \t]+activity[ \t]+(?:start(?=[ \t]|$)|start-activity(?=[ \t]|$)|start-in-vsync(?=[ \t]|$))/i, targetFlags: ['--display'] },
  { name: 'cmd-activity-unscoped', pattern: /\bcmd[ \t]+activity[ \t]+(?:force-stop|kill|startservice|start-service|startforegroundservice|startfgservice|start-foreground-service|start-fg-service|broadcast|instrument)\b/i, targetFlags: [] },
  { name: 'monkey', pattern: /\bmonkey\b/i, targetFlags: [] },
]

/** A flag only certifies a display when that exact command actually consumes it. */
function hasUncertifiedSelector(text: string, family: ScreenCommandFamily): boolean {
  const words = text.split(' ')
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    if (word === '-d' && (family.name.startsWith('am') || family.name.startsWith('cmd-activity'))) {
      i += 1 // Intent data, never a display certificate.
      continue
    }
    if (family.name === 'wm' && word === '-u') return true // Unique display IDs require another registry.
    if (word === '-d' || word === '--display' || word === '--display-id') {
      if (!family.targetFlags.includes(word) || !/^[0-9]+$/.test(words[i + 1] ?? '')) return true
      let at = words.indexOf(family.name === 'cmd-activity' ? 'activity' : family.name)
      if (at < 0) return true
      if (family.name === 'input') {
        at += 1
        if (/^(?:keyboard|dpad|gamepad|touchscreen|mouse|stylus|trackball|touchpad|touchnavigation|joystick)$/.test(words[at] ?? '')) at += 1
        if (i !== at) return true
      } else if (family.name === 'wm') {
        if (i !== at + 2 && i !== at + 3) return true
      } else if (family.name === 'am' || family.name === 'cmd-activity') {
        if (i !== at + 2) return true
      } else if (family.name === 'screencap') {
        if (!words.slice(at + 1, i).every((arg) => arg === '-p' || arg === '-h')) return true
      } else if (family.name === 'screenrecord' && i !== at + 1) return true
      i += 1
    } else if (/^-d.+|^--display/.test(word)) {
      // Compact/equal/unknown selector spellings have different semantics in each Android CLI.
      return true
    }
  }
  return false
}

/** 命令（归一化后）命中哪些命令词家族。 */
export function screenCommandFamilies(command: string): string[] {
  const normalized = stripDisplayOptions(scopeCommandText(command) ?? '')
  return SCREEN_COMMAND_FAMILIES.filter((family) => family.pattern.test(normalized)).map((f) => f.name)
}

/** 该命令是否命中真实屏读写命令词面（不论它能否自证目标屏）。 */
export function commandTargetsRealScreen(command: string): boolean {
  return screenCommandFamilies(command).length > 0
}

/**
 * 屏幕范围判定的结果码（跨语言契约：Kotlin `ScreenCommandVerdict` 与本联合的字符串逐字相同，
 * 由 `scripts/gen-screen-scope-fixture.mjs` 的 fixture 双向锁死）。
 */
export type ScreenCommandVerdict = 'allow' | 'deny-unparsed' | 'deny-orphan-target-token' | 'deny-uncertified-target'

/**
 * 纯判据：一条 raw shell 命令在 virtual-only 下是否**只**作用于已注册虚拟屏。
 *
 * `isOwnedTarget(raw)`：该十进制串是否属于一块**已注册**虚拟屏（displayId 空间或 SF token
 * 空间，两个空间的取值都按**原样字符串**比对；`0` 恒为真实屏、永不属于）。
 *
 * 三态拒绝（每一态都有独立的反证用例）：
 *   - `deny-unparsed`：引号不闭合 / 嵌套过深 —— 看不懂就不放行；
 *   - `deny-orphan-target-token`：某段带目标屏参数却**自身不含任何屏幕命令词**。这类 token 没有
 *     合法用途，它的存在只为「给同一行的其它命令发通行证」（`echo -d <token>; cat …` 形态）；
 *   - `deny-uncertified-target`：命中屏幕命令词面，但该家族**没有**可用目标屏参数、参数缺席、
 *     或参数值不在注册表里（无参 `screencap`、`-d 0`、`-d <未知>`、`am start -d 5` 都在此列）。
 *
 * 与壳侧 `ShellOps.decideScreenCommand` 同一算法（Kotlin 侧为执行点复查的第二份实现）。
 */
export function screenCommandVerdict(
  command: string,
  isOwnedTarget: (raw: string) => boolean,
): ScreenCommandVerdict {
  const { segments, unparsed } = splitCommandSegments(command)
  if (unparsed) return 'deny-unparsed'
  for (const segment of segments) {
    const bare = scopeCommandText(segment) ?? ''
    const options = displayOptionsIn(bare)
    const families = SCREEN_COMMAND_FAMILIES.filter(
      (family) => family.pattern.test(stripDisplayOptions(bare)),
    )
    if (families.length === 0) {
      // 非屏幕命令段：允许，但**不得**携带目标屏凭据（否则就是洗白凭据）。
      if (options.length > 0) return 'deny-orphan-target-token'
      continue
    }
    for (const family of families) {
      if (hasUncertifiedSelector(bare, family)) return 'deny-uncertified-target'
      if (family.targetFlags.length === 0) return 'deny-uncertified-target'
      const owned = options
        .filter((option) => family.targetFlags.includes(option.flag))
        .map((option) => option.value)
      // 该家族必须在**本段内**自证：参数缺席、或任一值不属于已注册虚拟屏 → 拒（不得只认证其中一个）。
      if (owned.length === 0) return 'deny-uncertified-target'
      if (!owned.every(isOwnedTarget)) return 'deny-uncertified-target'
    }
  }
  return 'allow'
}

/** 由注册表投影构造「该值是否属于已注册虚拟屏」的判据（两个 id 空间都按原样字符串比对）。 */
function ownedTargetPredicate(options: ScreenAccessOptions): (raw: string) => boolean {
  const ids = options.virtualDisplayIds
  const idSet = ids === undefined ? null : (ids instanceof Set ? ids : new Set<number>(ids))
  const sf = options.sfVirtualDisplays
  const aliases = options.virtualAliases
  let ownedTokens: ReadonlySet<string> = new Set<string>()
  if (sf !== undefined && aliases !== undefined && sf.length > 0) {
    const aliasSet = aliases instanceof Set ? aliases : new Set<string>(aliases)
    if (aliasSet.size > 0) {
      ownedTokens = new Set(sf.filter((entry) => aliasSet.has(entry.alias)).map((entry) => entry.token))
    }
  }
  return (raw: string): boolean => {
    if (raw === String(REAL_DISPLAY_ID)) return false
    const id = Number(raw)
    if (idSet !== null && Number.isInteger(id) && idSet.has(id)) return true
    return ownedTokens.has(raw)
  }
}

/**
 * 块G F6：解析 `dumpsys SurfaceFlinger` 输出里的**虚拟屏 token ↔ 产品别名**配对。
 *
 * 输入取自受支持的抽取命令（输出很小，避免全文超壳侧 16 KiB 上限）：
 * ```
 * dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'
 * ```
 * 设备实测（MuMu x86_64 模拟器 / Android 15 / API 35）逐字形态：
 * ```
 *     name="mumuscreen000"
 * Virtual Display 11529215046816944610
 *     name="DSH virtual-1"
 * ```
 * 该命令**不被** [SCREEN_COMMAND_FAMILIES] 命中（后者只认 `dumpsys (window|display|input)`），
 * 故本次改动**不扩大 shell 命令词面**——它只让范围判定能核对 SF token，不是放宽执行面。
 *
 * 尾随空白必须容忍：设备 `dumpsys` 输出常见行尾空格，而旧实现用 `matchEntire` 钉死整行 ⇒
 * 壳侧解析恒空、判定恒拒（N-5 的功能回归面；本函数按 `trimEnd` 语义匹配）。
 *
 * 纯函数：无 IO、无全局态，可离线单测。token 全程按字符串（见 [adbCommandDisplayTokens]）。
 */
export function screenTokensFromSfDump(sfDump: string): Array<{ alias: string; token: string }> {
  const out: Array<{ alias: string; token: string }> = []
  let pending: string | null = null
  for (const rawLine of String(sfDump ?? '').split(/\r?\n/)) {
    const tokenLine = /^Virtual Display[ \t]+(\d+)[ \t]*$/.exec(rawLine.trim())
    if (tokenLine !== null) {
      pending = tokenLine[1]
      continue
    }
    if (pending === null) continue
    const nameLine = /^[ \t]*name="([^"]*)"[ \t]*$/.exec(rawLine)
    if (nameLine === null) continue
    const displayName = nameLine[1]
    // 壳侧 createVirtualDisplay 用 "DSH <alias>" 命名（VdisplayController.create）。
    if (displayName.startsWith('DSH ')) out.push({ alias: displayName.slice('DSH '.length), token: pending })
    // 配对已消费（无论是否 DSH 屏）：防止把下一个 name= 错配到本 token 上。
    pending = null
  }
  return out
}

/**
 * Raw shell 面的屏幕范围判定（**引擎侧第一道**；壳侧 `ShellOps.scopeDenied` 是执行点的第二道）。
 *
 * @returns 拒绝文案（目标显示超出当前范围或无法认证）；null = 放行。
 */
export function realScreenAdbCommandDenied(
  scope: UserScreenScope,
  command: string,
  options: ScreenAccessOptions = {},
): string | null {
  if (scope === 'all') return null
  if (scope === 'real-only') {
    const parsed = splitCommandSegments(command)
    if (parsed.unparsed) return realOnlyScreenScopeMessage()
    for (const segment of parsed.segments) {
      const bare = scopeCommandText(segment) ?? ''
      const options = displayOptionsIn(bare)
      const families = SCREEN_COMMAND_FAMILIES.filter(
        (family) => family.pattern.test(stripDisplayOptions(bare)),
      )
      for (const family of families) {
        if (hasUncertifiedSelector(bare, family)) return realOnlyScreenScopeMessage()
        // Commands without a display selector use Android's physical default display (0).
        // If a family has no documented selector, any display-looking option is ambiguous.
        const relevant = options.filter((option) => family.targetFlags.includes(option.flag))
        if (family.targetFlags.length === 0 && options.length > 0) return realOnlyScreenScopeMessage()
        if (relevant.some((option) => option.value !== String(REAL_DISPLAY_ID))) {
          return realOnlyScreenScopeMessage()
        }
      }
    }
    return null
  }
  const verdict = screenCommandVerdict(command, ownedTargetPredicate(options))
  if (verdict === 'allow') return null
  const head = '用户当前开放屏幕范围为 virtual-only，不允许读取或操作真实屏内容'
    + '（screencap/screenrecord/uiautomator/input/wm/dumpsys window|display|input/am/cmd activity/monkey）。'
  if (verdict === 'deny-unparsed') {
    return head + '本条命令含无法安全解析的 shell 语法、脚本执行器或屏幕命令别名，无法核对目标屏，故拒绝。'
      + '请改为直接、可静态核对的命令后重试。'
  }
  if (verdict === 'deny-orphan-target-token') {
    return head + '本条命令的某个命令段携带了 `-d`/`--display` 目标屏参数，自身却不含任何屏幕命令词——'
      + '目标屏参数只能由**作用在该屏上**的命令段携带（一行参数不得给同行其它命令发通行证）。'
      + '若该参数不是屏幕目标参数（例如 `curl -d <数据>`），请改用其长选项写法（如 `--data`）后重试。'
  }
  return head + '命令里显式指定的目标屏须为**已注册虚拟屏**（DisplayManager displayId 或该屏的 '
    + 'SurfaceFlinger token），且参数须使用该命令支持的拼写与位置；本条命令未能通过核对，故拒绝。'
    + '请确认虚拟屏仍在活跃状态（android_vdisplay_create / vdInfo），或由用户在设置中修改范围后重试。'
}

function realOnlyScreenScopeMessage(): string {
  return '用户当前开放屏幕范围为 real-only；屏幕命令只能作用于物理屏 display 0。'
    + '虚拟屏或无法确认的显式显示目标已拒绝。非屏幕 shell 命令仍按原策略执行。'
}

/** Normalize only the three product settings values; corrupt data fails closed. */
export function normalizeScreenScope(value: unknown): UserScreenScope {
  return value === 'virtual-only' || value === 'real-only' || value === 'all' ? value : DEFAULT_SCREEN_SCOPE
}

/** Parse the native ScreenScopePrefs XML without allowing an engine plugin to write that preference. */
export function parseScreenScopePrefsXml(xml: string): UserScreenScope {
  const match = /<string\s+name="scope">([^<]*)<\/string>/.exec(xml)
  return normalizeScreenScope(match?.[1])
}

function scopePrefsPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DSH_SCREEN_SCOPE_PREFS_PATH) return env.DSH_SCREEN_SCOPE_PREFS_PATH
  if (env.TERMUX__PREFIX && env.DSH_HOME) return SHELL_SCREEN_SCOPE_PREFS_DEFAULT
  return undefined
}

/**
 * Read the native preference afresh for each device operation. Test-only environment input is
 * intentionally gated, so a stale generic environment value cannot override the shell preference.
 */
export function currentScreenScope(env: NodeJS.ProcessEnv = process.env): UserScreenScope {
  if (env.DSH_SCREEN_SCOPE_TEST === '1' || env.DSH_SCREEN_SCOPE_TEST === 'true') {
    return normalizeScreenScope(env.DSH_SCREEN_SCOPE)
  }
  const path = scopePrefsPath(env)
  if (path === undefined) return DEFAULT_SCREEN_SCOPE
  try {
    return parseScreenScopePrefsXml(readFileSync(path, 'utf8'))
  } catch {
    return DEFAULT_SCREEN_SCOPE
  }
}

/**
 * Decide the executable physical/virtual-screen target for the user-owned scope.
 *
 * VirtualDisplay is deliberately not guessed from an Android numeric id: the alias must be resolved
 * through the native registry (`screens()` / `vdInfo`) and passed in via [ScreenAccessOptions].
 * Without a resolved id, before the display is ready every virtual request fails explicitly
 * (`screen-not-ready`) — never a silent fallback to display 0 (U-3).
 */
export function decideScreenAccess(
  scope: UserScreenScope,
  requested?: string,
  options: ScreenAccessOptions = {},
): ScreenAccessDecision {
  const screenId = requested === undefined || requested === '' ? REAL_SCREEN_ID : requested
  if (screenId !== REAL_SCREEN_ID && !isVirtualScreenId(screenId)) {
    return {
      ok: false,
      reason: 'screen-not-found',
      scope,
      screenId,
      guidance: `未知屏幕 ${screenId}；请先调用 android_screen_list，并使用 real 或 virtual-N。`,
    }
  }
  const inScope = scope === 'all' || (scope === 'real-only' && screenId === REAL_SCREEN_ID) || (scope === 'virtual-only' && isVirtualScreenId(screenId))
  if (!inScope) {
    return {
      ok: false,
      reason: 'screen-out-of-scope',
      scope,
      screenId,
      guidance: `用户当前开放屏幕范围为 ${scope}，不允许读取或操作 ${screenId}。请由用户在设置中修改范围。`,
    }
  }
  if (isVirtualScreenId(screenId)) {
    const resolved = options.virtualDisplayId
    if (typeof resolved === 'number' && Number.isInteger(resolved) && resolved > 0) {
      // review C11 alias 契约闭环：原生注册表给出的动态 displayId（绝不假设恒为 1、绝不回退 0）。
      return { ok: true, screenId, displayId: resolved, scope }
    }
    return {
      ok: false,
      reason: 'screen-not-ready',
      scope,
      screenId,
      guidance: `虚拟屏幕 ${screenId} 尚未就绪；系统绝不会把虚拟屏静默映射为真实屏幕 display 0。`,
    }
  }
  return { ok: true, screenId: REAL_SCREEN_ID, displayId: REAL_DISPLAY_ID, scope }
}
