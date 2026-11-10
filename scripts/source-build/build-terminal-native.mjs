#!/usr/bin/env node
// 交叉编译侧栏原生终端内核（libvterm + JNI）为 Android .so。
//
// 为什么走来源链预编译而不是 Gradle externalNativeBuild：
//  - PR 门禁的 Kotlin 单测作业不需要 NDK；把 NDK 强绑到 AGP 会让该作业也依赖 NDK；
//  - 来源链已经下载并钉定 NDK r30（build-apk-source.yml），这里复用同一份工具链；
//  - .so 以预编译 jniLibs 目录注入（-PterminalNativeLibraryDir），与既有 Linux native 库同一机制。
//
// 用法：
//   node scripts/source-build/build-terminal-native.mjs <ndkRoot> <outRoot> --abi arm64|x86_64 [--report <path>]
//   node scripts/source-build/build-terminal-native.mjs --self-test
//   node scripts/source-build/build-terminal-native.mjs <ndkRoot> <outRoot> --abi arm64 --dry-run
//
// 输出：<outRoot>/<abiDir>/libpocketharness_terminal.so（abiDir = arm64-v8a / x86_64）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const CPP = join(ROOT, 'app', 'src', 'main', 'cpp')
const LIBVTERM = join(CPP, 'libvterm')
const OUTPUT_NAME = 'libpocketharness_terminal.so'

/** libvterm 的 C 源（与 app/src/main/cpp/CMakeLists.txt 同步；新增文件必须两处同改）。 */
export const LIBVTERM_SOURCES = [
  'vterm.c', 'parser.c', 'state.c', 'screen.c', 'pen.c', 'keyboard.c', 'mouse.c', 'unicode.c', 'encoding.c',
]

/** ABI 到 NDK clang 前缀与 jniLibs 目录的映射。 */
export function abiConfig(abi) {
  if (abi === 'arm64') return { clang: 'aarch64-linux-android26-clang', dir: 'arm64-v8a' }
  if (abi === 'x86_64') return { clang: 'x86_64-linux-android26-clang', dir: 'x86_64' }
  throw new Error(`unsupported ABI: ${abi}`)
}

/** 构造完整的 clang 命令行（不执行）。 */
export function compileArgs(ndkRoot, outRoot, abi) {
  const config = abiConfig(abi)
  const ndk = resolve(ndkRoot)
  const clang = join(ndk, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin', config.clang)
  const outDir = join(resolve(outRoot), config.dir)
  const output = join(outDir, OUTPUT_NAME)
  const sources = [
    join(CPP, 'terminal_jni.c'),
    ...LIBVTERM_SOURCES.map((name) => join(LIBVTERM, 'src', name)),
  ]
  const args = [
    '-std=c99', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra',
    '-Wno-unused-parameter',
    '-o', output,
    ...sources,
    '-I', join(LIBVTERM, 'include'),
    '-I', join(LIBVTERM, 'src'),
    '-lm',
  ]
  return { clang, args, output, outDir, sources }
}

function validate(ndkRoot, abi, plan) {
  if (!existsSync(plan.clang)) throw new Error(`NDK clang not found: ${plan.clang}`)
  for (const source of plan.sources) {
    if (!existsSync(source)) throw new Error(`terminal source missing: ${source}`)
  }
  if (!['arm64', 'x86_64'].includes(abi)) throw new Error(`unsupported ABI: ${abi}`)
}

function selfTest() {
  let checked = 0
  for (const abi of ['arm64', 'x86_64']) {
    const config = abiConfig(abi)
    if (abi === 'arm64' && (config.clang !== 'aarch64-linux-android26-clang' || config.dir !== 'arm64-v8a')) throw new Error('arm64 mapping drift')
    if (abi === 'x86_64' && (config.clang !== 'x86_64-linux-android26-clang' || config.dir !== 'x86_64')) throw new Error('x86_64 mapping drift')
    const plan = compileArgs('/nonexistent-ndk', '/tmp/terminal-out', abi)
    for (const source of plan.sources) if (!existsSync(source)) throw new Error(`self-test source missing: ${source}`)
    if (!plan.args.includes('-shared') || !plan.args.includes('-fPIC')) throw new Error('self-test lost shared/PIC flags')
    checked += 1
  }
  console.log(`SELF-TEST PASSED（${checked} ABIs，libvterm 源 ${LIBVTERM_SOURCES.length} + JNI 1）`)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) { selfTest(); return }
  const [ndkRoot, outRoot] = argv
  const abiIndex = argv.indexOf('--abi')
  const abi = abiIndex >= 0 ? argv[abiIndex + 1] : undefined
  const reportIndex = argv.indexOf('--report')
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : undefined
  if (!ndkRoot || !outRoot || !abi) {
    console.error('usage: build-terminal-native.mjs <ndkRoot> <outRoot> --abi arm64|x86_64 [--report <path>]')
    process.exit(2)
  }
  const plan = compileArgs(ndkRoot, outRoot, abi)
  if (argv.includes('--dry-run')) {
    validate(ndkRoot, abi, plan)
    console.log(`DRY-RUN ${plan.clang} ${plan.args.join(' ')}`)
    return
  }
  validate(ndkRoot, abi, plan)
  mkdirSync(plan.outDir, { recursive: true })
  console.log(`[terminal-native/${abi}] ${plan.clang} -> ${plan.output}`)
  const result = spawnSync(plan.clang, plan.args, { encoding: 'utf8', stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`clang failed (${result.status})`)
  if (!existsSync(plan.output)) throw new Error(`clang reported success but output is missing: ${plan.output}`)
  const sha256 = createHash('sha256').update(readFileSync(plan.output)).digest('hex')
  const report = {
    abi,
    abiDir: abiConfig(abi).dir,
    output: plan.output,
    sha256,
    compiler: plan.clang,
    sources: plan.sources.length,
    libvterm: 'MIT vendored (see LICENSES/libvterm.txt)',
  }
  if (reportPath) {
    mkdirSync(dirname(resolve(reportPath)), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(`[terminal-native/${abi}] sha256=${sha256}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) }
}
