/**
 * Android/Termux service provider for the bash capability seam.
 *
 * Extends the local bash executor with the Termux execution world:
 * - every spawn carries an explicit, self-contained Termux environment
 *   (PATH/LD_LIBRARY_PATH/HOME/PREFIX/TERMUX_VERSION/SHELL), so execution
 *   never depends on the ambient environment being accidentally correct;
 * - run/start hand an explicit bashPath to the inherited subprocess
 *   mechanics (process-group SIGTERM→SIGKILL, output caps + spill, grace),
 *   reusing LocalBashExecutor's budgets and lifecycle unchanged;
 * - the sandbox declaration is honest: enforcement is the Android app domain
 *   (SELinux u0_aXXX) plus the approval flow, not a path-level confiner, so
 *   results report `enforcement: 'partial'` and the default mode stays
 *   `workspace-write` (same as the desktop default) for permission presets;
 * - probe() reports bash presence/version and the toolchain the model-facing
 *   tools rely on; misconfigured bash fails loudly with repair guidance.
 *
 * Mount only on Android (patch row `disabled: !!js process.platform !== 'android'`).
 * @module @dsh-android/dsh-shell-termux
 */

import { accessSync, constants } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'

/** Default grace period passed to probe spawns. */
const PROBE_GRACE_MS = 3_000
const SANDBOX_MODES: readonly SandboxMode[] = ['workspace-write', 'danger-full-access', 'read-only']

/** Read the session policy without trusting a caller-controlled environment variable. */
function modeFromPolicy(value: unknown, fallback: SandboxMode): SandboxMode | undefined {
  if (value === null || typeof value !== 'object') return fallback
  const policy = (value as { sandboxPolicy?: unknown }).sandboxPolicy
  if (policy === undefined || policy === null) return fallback
  if (typeof policy !== 'object') return undefined
  const mode = (policy as { mode?: unknown }).mode
  if (mode === undefined) return fallback
  return typeof mode === 'string' && SANDBOX_MODES.includes(mode as SandboxMode)
    ? mode as SandboxMode
    : undefined
}

/** Full access must be selected by this call's session policy, never inherited from plugin config. */
function hasExplicitPolicyMode(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const policy = (value as { sandboxPolicy?: unknown }).sandboxPolicy
  if (policy === null || typeof policy !== 'object') return false
  return typeof (policy as { mode?: unknown }).mode === 'string'
}

/** Fail-closed result when Android cannot enforce a restricted bash mode. */
function sandboxUnavailable(mode: unknown): Error & { code: string } {
  const requested = typeof mode === 'string' ? mode : 'unknown'
  const error = new Error(
    `SANDBOX_UNAVAILABLE: Android cannot enforce ${requested} for arbitrary bash commands because no path-level confiner is available. The command was not started. Select danger-full-access in the user's permission settings to run with app-domain access, or use a shell backend with a real path fence.`,
  ) as Error & { code: string }
  error.name = 'SandboxUnavailableError'
  error.code = 'SANDBOX_UNAVAILABLE'
  return error
}

function fullAccessSelectionRequired(): Error & { code: string } {
  const error = new Error(
    'SANDBOX_SELECTION_REQUIRED: Android shell requires this call\'s session policy to explicitly select danger-full-access. The command was not started.',
  ) as Error & { code: string }
  error.name = 'SandboxSelectionRequiredError'
  error.code = 'SANDBOX_SELECTION_REQUIRED'
  return error
}

/**
 * Tools the dsh tool surface relies on beyond bash itself (pkg names).
 * Exported (ST-17): the engine-side toolchain view (`android_toolchain_status`) consumes
 * THIS table instead of keeping a second literal list — one table, one truth.
 */
export const REQUIRED_TOOLCHAIN = ['bash', 'coreutils', 'findutils', 'grep', 'ripgrep'] as const

/** Executables probed under `$PREFIX/bin` (coreutils/findutils/grep basics). Exported for the same reason. */
export const PROBE_BINARIES = ['bash', 'ls', 'cat', 'grep', 'find', 'sed', 'cp', 'mv', 'rm', 'mkdir', 'rg'] as const

/** 包名 → 代表性被探二进制（probe() 与引擎侧工具链视图共用同一映射）。 */
export const TOOLCHAIN_REPRESENTATIVE: Readonly<Record<(typeof REQUIRED_TOOLCHAIN)[number], (typeof PROBE_BINARIES)[number]>> = {
  bash: 'bash',
  coreutils: 'ls',
  findutils: 'find',
  grep: 'grep',
  ripgrep: 'rg',
}

/**
 * Plugin config: the local executor's knobs verbatim, plus the Termux world
 * coordinates. bashPath/prefix/home are deployment facts (patch config), not
 * user settings; the inherited knobs remain editable through the shell
 * settings section exactly as on desktop.
 */
export interface Config extends LocalConfig {
  /** Absolute path to the Termux bash binary (default probe: $PREFIX/bin/bash). */
  bashPath: string
  /** Termux prefix root (the directory containing bin/, lib/, etc.). */
  prefix: string
  /** Termux home directory (commands' ambient HOME, usually .../files/home). */
  home: string
  /** Termux version string injected as TERMUX_VERSION. */
  termuxVersion?: string
  /** Extra PATH entries prepended to the injected PATH (e.g. /system/bin). */
  extraPath?: string[]
  /** Default permission mode reported to the shell tool. Android cannot enforce path-restricted modes. */
  writeMode?: SandboxMode
  /** Model workspace root advertised to child processes; this is not an execution fence. */
  workspaceRoot?: string
  /** User-selected shared directories advertised to child processes; these are not an execution fence. */
  sharedDirs?: string[]
}

/** The shape after schemastery applied the defaults (optional fields keep their undefined). */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'termuxVersion' | 'extraPath' | 'writeMode' | 'workspaceRoot' | 'sharedDirs'>> &
  Pick<Config, 'cwd' | 'termuxVersion' | 'extraPath' | 'writeMode' | 'workspaceRoot' | 'sharedDirs'>

/** Result of the environment probe, for diagnostics/UI panels. */
export interface ProbeResult {
  /** full = bash + toolchain OK; partial = bash OK, some tools missing; unusable = bash missing. */
  status: 'full' | 'partial' | 'unusable'
  /** The configured bash path. */
  bash: string
  /** First line of `bash --version`, when bash runs. */
  bashVersion?: string
  /** Missing toolchain package names (pkg install hints). */
  missing: string[]
  /** 写面档位（PRD F1.4）：探测结果附带当前档位，供工具链状态/缺包提示/写面状态面板消费。 */
  writeMode?: SandboxMode
}

/**
 * Termux bash executor over the inherited subprocess mechanics. Registers as
 * `ctx.shell` in place of the local/sandbox executors on Android; the tool
 * layer and approval flow are unchanged consumers.
 */
export class TermuxBashExecutor extends LocalBashExecutor {
  // No own Config: the inherited knobs' schema (with defaults) is inherited
  // verbatim — schemastery preserves unknown keys (verified), so the Termux
  // coordinates arrive in the raw config and are validated in the constructor.
  private readonly bashPath: string
  private readonly prefix: string
  private readonly home: string
  private readonly termuxVersion: string
  private readonly extraPath: readonly string[]
  private readonly writeMode: SandboxMode
  private readonly workspaceRoot?: string
  private readonly sharedDirs: readonly string[]
  private readonly resolvedModes = new WeakMap<object, { mode: SandboxMode | undefined; explicit: boolean }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const entry = config as ResolvedConfig
    for (const [name, value] of [['bashPath', entry.bashPath], ['prefix', entry.prefix], ['home', entry.home]] as const) {
      if (typeof value !== 'string' || !value.startsWith('/')) {
        throw new Error(`shell-termux: ${name} must be an absolute path, got ${String(value)}`)
      }
    }
    this.bashPath = entry.bashPath
    this.prefix = entry.prefix
    this.home = entry.home
    this.termuxVersion = entry.termuxVersion ?? '0.118.3'
    this.extraPath = entry.extraPath ?? []
    const mode = entry.writeMode ?? 'workspace-write'
    if (!['workspace-write', 'danger-full-access', 'read-only'].includes(mode)) {
      throw new Error(`shell-termux: invalid writeMode '${String(mode)}' (workspace-write | danger-full-access | read-only)`)
    }
    this.writeMode = mode
    this.workspaceRoot = entry.workspaceRoot
    this.sharedDirs = entry.sharedDirs ?? []
  }

  /** The configured default mode read by permission presets. Restricted modes fail closed in execute(). */
  override get sandboxMode(): SandboxMode {
    return this.writeMode
  }

  /** Stamp Termux's environment and diagnostic permission mode. These values do not constrain bash. */
  private termuxEnv(mode = this.writeMode): Record<string, string> {
    return {
      PATH: [...this.extraPath, `${this.prefix}/bin`, '/system/bin'].join(':'),
      LD_LIBRARY_PATH: `${this.prefix}/lib`,
      HOME: this.home,
      PREFIX: this.prefix,
      TERMUX_VERSION: this.termuxVersion,
      SHELL: this.bashPath,
      DSH_WRITE_MODE: mode,
      ...this.workspaceRoot ? { DSH_WORKSPACE: this.workspaceRoot } : {},
      DSH_SHARED_DIRS: this.sharedDirs.join(':'),
    }
  }

  /** Labels stay controlled for diagnostics; the real fail-closed check is in execute(). */
  private static readonly FENCE_KEYS = ['DSH_WRITE_MODE', 'DSH_WORKSPACE', 'DSH_SHARED_DIRS'] as const

  /** Stamp the controlled Termux environment onto every request. */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const mode = modeFromPolicy(request, this.writeMode)
    const fence = this.termuxEnv(mode ?? this.writeMode)
    const user = { ...request.env }
    for (const k of TermuxBashExecutor.FENCE_KEYS) delete user[k]
    const spec = super.resolve({ ...request, env: { ...fence, ...user } })
    // 坑 537（R3-27）：父类 spawnSpec 的合并序是 {…overrides, …spec.env, …spec.dshEnv}——
    // dshEnv（in-process hooks 的受信通道，类型允许任意 DSH_* 键）合并最晚，能把 fence
    // 三个标签整体顶掉，使「自包含环境」声明与诊断标签真实性失守。真实授权门不读环境
    // 变量（execute 只信 sandboxPolicy），但标签必须不可伪造：在 spec 层重盖，fence 恒胜。
    // 返回的是新对象，WeakMap 键必须落在返回值上（消费方按 resolve 的产物查 execute）。
    const dshEnv: Record<string, string> = { ...(spec.dshEnv ?? {}) }
    for (const k of TermuxBashExecutor.FENCE_KEYS) delete dshEnv[k]
    const stamped: ShellExecSpec = { ...spec, dshEnv: { ...dshEnv, ...fence } }
    this.resolvedModes.set(stamped, { mode, explicit: hasExplicitPolicyMode(request) })
    return stamped
  }

  /** Reject with repair guidance when the configured bash is not executable. */
  private assertBash(): void {
    try {
      accessSync(this.bashPath, constants.X_OK)
    } catch {
      throw new Error(
        `shell-termux: ${this.bashPath} is not executable; run 'pkg install bash' in Termux or fix bashPath/prefix in the shell-termux plugin config`,
      )
    }
  }

  /** The executor's shell argv for one command. */
  private bashArgv(command: string): readonly string[] {
    return [this.bashPath, '-c', command]
  }

  /**
   * Stamp the Android app-domain fact onto one execution — on the handle (so a
   * background consumer reads it before the process settles) and on the result
   * projection (foreground consumers). The handle is mutated in place, never
   * rebuilt: 0.1.7's `ShellExecution` carries spawn state on the instance, so a
   * spread copy would hand back a handle whose `done`/read path is detached.
   */
  private declareSandbox(execution: ShellExecution, mode: SandboxMode): ShellExecution {
    const facts = { mode, denied: false, enforcement: 'partial' } as const
    const base = execution.result.bind(execution)
    let decorated: Promise<ShellRunResult> | undefined
    execution.sandbox = facts
    execution.result = () => {
      decorated ??= base().then((result) => ({ ...result, sandbox: facts }))
      return decorated
    }
    return execution
  }

  /**
   * 0.1.7 renamed the executor pair `run`/`start` to a single `execute` that
   * returns a handle with a lazy `result()`; argv substitution now goes through
   * the protected `executeArgv` (same slot upstream's sandbox executor confines
   * through). Background consumers take the handle and skip `result()`.
   */
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const resolved = this.resolvedModes.get(spec as object)
    const mode = resolved?.mode ?? modeFromPolicy(spec, this.writeMode)
    const explicit = resolved?.explicit ?? hasExplicitPolicyMode(spec)
    if (mode !== 'danger-full-access') throw sandboxUnavailable(mode)
    if (!explicit) throw fullAccessSelectionRequired()
    this.assertBash()
    return this.declareSandbox(await this.executeArgv(spec, this.bashArgv(spec.command)), mode)
  }

  /**
   * Probe the Termux execution world: bash presence/version plus the
   * model-tool toolchain. Never throws; unusable states are structured data.
   */
  async probe(): Promise<ProbeResult> {
    const missing = new Set<string>()
    for (const tool of PROBE_BINARIES) {
      const path = tool === 'bash' ? this.bashPath : `${this.prefix}/bin/${tool}`
      try {
        accessSync(path, constants.X_OK)
      } catch {
        missing.add(tool)
      }
    }
    if (missing.has('bash')) {
      return { status: 'unusable', bash: this.bashPath, missing: [...REQUIRED_TOOLCHAIN], writeMode: this.writeMode }
    }
    const bashVersion = await this.readBashVersion()
    // Map toolchain packages to their probed representative binary.
    const missingPkgs = REQUIRED_TOOLCHAIN.filter((pkg) => missing.has(TOOLCHAIN_REPRESENTATIVE[pkg]))
    return {
      status: missingPkgs.length === 0 ? 'full' : 'partial',
      bash: this.bashPath,
      ...bashVersion !== undefined ? { bashVersion } : {},
      missing: missingPkgs,
      writeMode: this.writeMode,
    }
  }

  /** First line of `bash --version`, or undefined when bash cannot report it. */
  private async readBashVersion(): Promise<string | undefined> {
    const spawnSpec: SubprocessSpawnSpec = {
      argv: [this.bashPath, '--version'],
      cwd: this.home,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096, spill: { maxBytes: 0 } },
        stderr: { maxBytes: 4096, spill: { maxBytes: 0 } },
      },
      graceMs: PROBE_GRACE_MS,
      env: { ...this.termuxEnv() },
    }
    const handle = this.ctx.subprocess.spawn(spawnSpec)
    const outcome = await handle.done
    const text = handle.collected.stdout?.readFrom(0).text ?? ''
    if (outcome.exitCode !== 0) return undefined
    return text.split('\n')[0] || undefined
  }
}

export default TermuxBashExecutor
