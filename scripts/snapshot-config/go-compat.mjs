#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MARKER = 'TERMUX_EXEC__PROC_SELF_EXE='
const ARG_SHIM = '__pocket_harness_bootstrap_arg__'

function fail(message) {
  console.error(`[go-compat] ${message}`)
  process.exitCode = 1
}

function run(file, args, options = {}) {
  return spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

function parseOptions(args) {
  const options = { positional: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--go' || arg === '--goroot' || arg === '--output') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      options[arg.slice(2)] = value
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`)
    } else {
      options.positional.push(arg)
    }
  }
  if (options.positional.length > 0) throw new Error(`unexpected argument: ${options.positional[0]}`)
  return options
}

function candidateGoPaths() {
  const home = process.env.HOME ?? ''
  const prefix = process.env.TERMUX__PREFIX ?? process.env.PREFIX ?? ''
  return [
    join(home, '.dsh/opt/golang/bin/go'),
    join(prefix, 'lib/go/bin/go'),
    join(prefix, 'bin/go'),
  ].filter(Boolean)
}

function resolveGoPath(input) {
  if (input) {
    const path = resolve(input)
    if (!existsSync(path)) throw new Error(`Go was not found at ${path}`)
    return realpathSync(path)
  }
  const found = candidateGoPaths().find(path => existsSync(path))
  if (found) return realpathSync(found)
  const which = run('/system/bin/sh', ['-c', 'command -v go'], { env: process.env })
  const fromPath = which.status === 0 ? which.stdout.trim() : ''
  if (fromPath && existsSync(fromPath)) return realpathSync(fromPath)
  throw new Error('Go was not found. Pass --go /absolute/path/to/go or install Go first.')
}

function goVersionProbe(goPath, extraArgs = []) {
  const result = run(goPath, [...extraArgs, 'version'], { env: process.env })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { status: result.status, output }
}

export function diagnoseGo(goPath) {
  const direct = goVersionProbe(goPath)
  if (direct.status === 0 && /^go version go\S+\s+android\/arm64$/m.test(direct.output)) {
    return { state: 'healthy', goPath, version: direct.output.split('\n')[0] }
  }
  const shimmed = goVersionProbe(goPath, [ARG_SHIM])
  if (shimmed.status === 0 && /^go version go\S+\s+android\/arm64$/m.test(shimmed.output)) {
    return {
      state: 'argv1-dropped',
      goPath,
      version: shimmed.output.split('\n')[0],
      directOutput: direct.output.slice(0, 1000),
    }
  }
  return {
    state: 'unknown',
    goPath,
    directOutput: direct.output.slice(0, 1000),
    shimmedOutput: shimmed.output.slice(0, 1000),
  }
}

const HELPER = `// androidTermuxArgvAdjust is true only for Termux's linker64 exec shim.
// os/exec_posix.go sets TERMUX_EXEC__PROC_SELF_EXE and places that executable
// path in argv[1]. Direct shell launches have no matching marker and keep argv.
func androidTermuxArgvAdjust() int32 {
	if GOOS != "android" || cgocfg.Enabled || argc < 2 {
		return 0
	}
	for i := int32(0); ; i++ {
		p := argv_index(argv, argc+1+i)
		if p == nil {
			break
		}
		env := gostringnocopy(p)
		if len(env) >= len("${MARKER}") && env[:len("${MARKER}")] == "${MARKER}" {
			selfExe := env[len("${MARKER}"):]
			if selfExe != "" && gostringnocopy(argv_index(argv, 1)) == selfExe {
				return 1
			}
			return 0
		}
	}
	return 0
}

`

/** Apply the narrow Termux Play Store runtime fix to the source patch from Go 1.26.2. */
export function patchRuntimeSource(source) {
  if (source.includes('func androidTermuxArgvAdjust() int32')) {
    if (source.includes('adjust := androidTermuxArgvAdjust()') && source.includes('argv_index(argv, androidTermuxArgvAdjust())')) {
      return { source, changed: false }
    }
    throw new Error('runtime1.go contains a partial Pocket Harness patch; refusing to guess.')
  }
  if (!source.includes('"cgocfg"') || !source.includes('func AndroidSelfExecutable() string')) {
    throw new Error('runtime1.go does not match the affected Termux Go runtime. No files were changed.')
  }

  const selfExePattern = /func AndroidSelfExecutable\(\) string \{[\s\S]*?\n\}/
  const selfExe = source.match(selfExePattern)
  if (!selfExe || !/argv_index\(argv,\s*adjust\)/.test(selfExe[0]) || !/adjust\s*=\s*1/.test(selfExe[0])) {
    throw new Error('AndroidSelfExecutable does not match the known unconditional argv adjustment.')
  }
  let patched = source.replace(selfExePattern,
    'func AndroidSelfExecutable() string {\n\treturn gostringnocopy(argv_index(argv, androidTermuxArgvAdjust()))\n}')

  const goargsStart = patched.indexOf('func goargs() {')
  if (goargsStart < 0) throw new Error('runtime1.go has no goargs function.')
  const goargsEnd = patched.indexOf('\n}', goargsStart)
  if (goargsEnd < 0) throw new Error('runtime1.go goargs function is malformed.')
  const before = patched.slice(0, goargsStart)
  const goargs = patched.slice(goargsStart, goargsEnd + 2)
  const after = patched.slice(goargsEnd + 2)
  const adjustPattern = /var adjust int32\s+if GOOS == "android" && !cgocfg\.Enabled \{\s+adjust = 1\s+\} else \{\s+adjust = 0\s+\}/
  if (!adjustPattern.test(goargs)) throw new Error('goargs does not match the known unconditional argv adjustment.')
  const fixedGoargs = goargs.replace(adjustPattern, 'adjust := androidTermuxArgvAdjust()')
  patched = before + HELPER + fixedGoargs + after
  return { source: patched, changed: true }
}

function parseSourceVersion(root) {
  const versionFile = join(root, 'VERSION')
  if (existsSync(versionFile)) return readFileSync(versionFile, 'utf8').trim().split(/\s+/)[0]
  const goPath = join(root, 'bin/go')
  if (existsSync(goPath)) {
    const probe = diagnoseGo(goPath)
    const match = /go version (go\S+)/.exec(probe.version ?? '')
    if (match) return match[1]
  }
  return 'unknown'
}

function findGoRoot(goPath, explicitRoot) {
  if (explicitRoot) return realpathSync(explicitRoot)
  if (process.env.GOROOT && existsSync(join(process.env.GOROOT, 'src/runtime/runtime1.go'))) return realpathSync(process.env.GOROOT)
  const rootFromGo = run(goPath, [ARG_SHIM, 'env', 'GOROOT'], { env: process.env })
  if (rootFromGo.status === 0 && rootFromGo.stdout.trim() && existsSync(join(rootFromGo.stdout.trim(), 'src/runtime/runtime1.go'))) {
    return realpathSync(rootFromGo.stdout.trim())
  }
  throw new Error('Go source was not found. Pass --goroot /absolute/path/to/goroot with src/runtime/runtime1.go.')
}

function safeCopyRoot(sourceRoot, destination) {
  const stat = lstatSync(sourceRoot)
  if (!stat.isDirectory()) throw new Error('GOROOT must be a directory.')
  cpSync(sourceRoot, destination, { recursive: true, dereference: false, preserveTimestamps: true })
}

function makeBootstrapShim(currentRoot, bootstrapRoot) {
  mkdirSync(join(bootstrapRoot, 'bin'), { recursive: true })
  for (const name of ['pkg', 'src', 'lib', 'misc']) {
    const source = join(currentRoot, name)
    if (existsSync(source)) symlinkSync(source, join(bootstrapRoot, name), 'dir')
  }
  for (const name of ['go', 'gofmt']) {
    const toolPath = join(currentRoot, 'bin', name)
    if (!existsSync(toolPath)) continue
    const wrapper = `#!/system/bin/sh\nexec ${shellQuote(toolPath)} ${ARG_SHIM} "$@"\n`
    writeFileSync(join(bootstrapRoot, 'bin', name), wrapper, { mode: 0o755 })
  }
  if (!existsSync(join(bootstrapRoot, 'bin/go'))) throw new Error(`Bootstrap Go is missing under ${currentRoot}`)
}

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function smokeRebuiltGo(goPath, root, work, env) {
  const sourcePath = join(work, 'argv-smoke.go')
  const binaryPath = join(work, 'argv-smoke')
  const source = `package main
import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)
func main() {
	if len(os.Args) > 1 && os.Args[1] == "child" {
		fmt.Printf("child:%s:%s\\n", strings.Join(os.Args[2:], ","), os.Getenv("POCKET_HARNESS_GO_SMOKE"))
		return
	}
	path, err := os.Executable()
	if err != nil { panic(err) }
	cmd := exec.Command(path, "child", "alpha", "beta")
	out, err := cmd.CombinedOutput()
	if err != nil { panic(fmt.Sprintf("child failed: %v: %s", err, out)) }
	fmt.Printf("args:%s\\n", strings.Join(os.Args[1:], ","))
	fmt.Printf("env:%s\\n", os.Getenv("POCKET_HARNESS_GO_SMOKE"))
	fmt.Printf("%s", out)
}
`
  writeFileSync(sourcePath, source)
  const build = run(goPath, ['build', '-o', binaryPath, sourcePath], { cwd: work, env })
  if (build.error || build.status !== 0) {
    throw new Error(`Rebuilt Go could not compile the argv smoke program: ${build.stderr || build.error?.message || `exit ${build.status}`}`)
  }
  const launched = run(binaryPath, ['alpha', 'beta'], {
    env: { ...env, GOROOT: root, POCKET_HARNESS_GO_SMOKE: 'ok' },
  })
  const output = `${launched.stdout ?? ''}${launched.stderr ?? ''}`
  if (launched.error || launched.status !== 0 || !output.includes('args:alpha,beta') || !output.includes('env:ok') || !output.includes('child:alpha,beta:ok')) {
    throw new Error(`Rebuilt Go failed the argv smoke check: ${output.trim() || launched.error?.message || `exit ${launched.status}`}`)
  }
  return output.trim()
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function rebuild(options) {
  const goPath = resolveGoPath(options.go)
  const diagnosis = diagnoseGo(goPath)
  if (diagnosis.state !== 'argv1-dropped') {
    throw new Error(`Rebuild expects the known argv[1]-drop bug; detected ${diagnosis.state}. Run 'go-compat diagnose' and check the selected Go binary.`)
  }
  const sourceRoot = findGoRoot(goPath, options.goroot)
  const runtimePath = join(sourceRoot, 'src/runtime/runtime1.go')
  const originalSource = readFileSync(runtimePath, 'utf8')
  const result = patchRuntimeSource(originalSource)
  if (!result.changed) throw new Error('The source already contains this fix; refusing to rebuild a second time.')
  const execSourcePath = join(sourceRoot, 'src/os/exec_posix.go')
  const execSource = existsSync(execSourcePath) ? readFileSync(execSourcePath, 'utf8') : ''
  if (!execSource.includes(MARKER)) {
    throw new Error('The selected GOROOT is missing Termux os/exec marker support; refusing to rebuild an unrelated Go source tree.')
  }

  const version = parseSourceVersion(sourceRoot).replace(/^go/, '')
  const home = process.env.HOME ?? dirname(sourceRoot)
  const defaultOutput = join(home, '.dsh/opt', `golang-argvfix-${version}`)
  const output = resolve(options.output ?? defaultOutput)
  if (existsSync(output)) throw new Error(`Output already exists; refusing to overwrite: ${output}`)
  if (isWithin(sourceRoot, output)) throw new Error('Output must be outside the original GOROOT.')
  const tempRoot = join(process.env.TMPDIR ?? join(home, 'tmp'), 'pocket-go-rebuild')
  mkdirSync(tempRoot, { recursive: true })
  const work = mkdtempSync(join(tempRoot, 'go-'))
  const stagedRoot = join(work, 'goroot')
  const bootstrapRoot = join(work, 'bootstrap')
  let published = false
  try {
    safeCopyRoot(sourceRoot, stagedRoot)
    writeFileSync(join(stagedRoot, 'src/runtime/runtime1.go'), result.source)
    makeBootstrapShim(sourceRoot, bootstrapRoot)
    const makeScript = join(stagedRoot, 'src/make.bash')
    if (!existsSync(makeScript)) throw new Error(`Go source build script is missing: ${makeScript}`)
    const env = {
      ...process.env,
      GOROOT: sourceRoot,
      GOROOT_BOOTSTRAP: bootstrapRoot,
      GOROOT_FINAL: output,
      GOOS: 'android',
      GOARCH: 'arm64',
      CGO_ENABLED: '0',
    }
    console.log(`[go-compat] Building ${diagnosis.version} for Android/arm64. Source: ${sourceRoot}`)
    console.log(`[go-compat] Temporary build tree: ${stagedRoot}`)
    const prefix = process.env.TERMUX__PREFIX ?? process.env.PREFIX ?? '/data/data/com.termux/files/usr'
    const built = run(join(prefix, 'bin/bash'), [makeScript], {
      cwd: join(stagedRoot, 'src'), env, stdio: 'inherit',
    })
    if (built.error) throw built.error
    if (built.status !== 0) throw new Error(`Go source build failed (exit ${built.status}). The original toolchain was not changed.`)
    renameSync(stagedRoot, output)
    published = true
    const rebuiltGo = join(output, 'bin/go')
    const versionResult = run(rebuiltGo, ['version'], { env: { ...env, GOROOT: output } })
    if (versionResult.status !== 0 || !/^go version go\S+ android\/arm64/m.test(`${versionResult.stdout}${versionResult.stderr}`)) {
      throw new Error(`Rebuilt Go failed its direct version check; inspect ${output} before using it.`)
    }
    const smoke = smokeRebuiltGo(rebuiltGo, output, work, { ...env, GOROOT: output, PATH: `${join(output, 'bin')}:${env.PATH ?? ''}` })
    console.log(`[go-compat] Rebuilt toolchain: ${output}`)
    console.log(`[go-compat] Version check: ${versionResult.stdout.trim()}`)
    console.log(`[go-compat] argv smoke: ${smoke}`)
    console.log(`[go-compat] Use it with: export GOROOT=${shellQuote(output)}; export PATH=${shellQuote(join(output, 'bin'))}:$PATH`)
  } catch (error) {
    if (published) console.error(`[go-compat] Build output was kept for inspection: ${output}`)
    throw error
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function selfTest() {
  const fixture = `package runtime
import "cgocfg"
func AndroidSelfExecutable() string {
	var adjust int32
	if cgocfg.Enabled { adjust = 0 } else { adjust = 1 }
	return gostringnocopy(argv_index(argv, adjust))
}
func goargs() {
	var adjust int32
	if GOOS == "android" && !cgocfg.Enabled { adjust = 1 } else { adjust = 0 }
	argslice = make([]string, argc-adjust)
	for i := int32(0); i < argc-adjust; i++ { idx := i; if i > 0 { idx += adjust }; argslice[i] = gostringnocopy(argv_index(argv, idx)) }
}
`
  const fixed = patchRuntimeSource(fixture)
  if (!fixed.changed || !fixed.source.includes('TERMUX_EXEC__PROC_SELF_EXE=') || !fixed.source.includes('adjust := androidTermuxArgvAdjust()')) {
    throw new Error('positive source patch fixture failed')
  }
  if (patchRuntimeSource(fixed.source).changed) throw new Error('idempotence check failed')
  let rejected = false
  try { patchRuntimeSource(fixture.replace('cgocfg.Enabled { adjust = 1 }', 'cgocfg.Enabled { adjust = 0 }')) } catch { rejected = true }
  if (!rejected) throw new Error('controlled negative source fixture was accepted')
  console.log('go-compat self-test: 2 positive checks and 1 controlled negative check passed')
}

function printHelp() {
  console.log(`Pocket Harness Go argv compatibility helper

Usage:
  go-compat diagnose [--go PATH]
  go-compat rebuild [--go PATH] [--goroot PATH] [--output PATH]
  go-compat --self-test

rebuild copies the selected GOROOT, applies a runtime fix gated by Termux's
TERMUX_EXEC__PROC_SELF_EXE marker, and builds a side-by-side Android/arm64 toolchain.
It never overwrites the selected GOROOT. Rebuild your Go applications with the
new toolchain; old binaries keep their original runtime behavior.
`)
}

function main() {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === '--self-test') return selfTest()
  if (command === 'help' || command === '--help' || command === '-h') return printHelp()
  const options = parseOptions(args)
  if (command === 'diagnose') {
    const goPath = resolveGoPath(options.go)
    const result = diagnoseGo(goPath)
    console.log(JSON.stringify(result, null, 2))
    if (result.state === 'unknown') process.exitCode = 2
    return
  }
  if (command === 'rebuild') return rebuild(options)
  throw new Error(`unknown command: ${command}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main() } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
}
