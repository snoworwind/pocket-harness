export const PERMISSION_AUTO_DEFAULT_MARKER = 'dsh-mobile auto review is a new-session default (AR1)'
export const AUTO_REVIEW_RUN_CODE_MARKER = 'dsh-mobile auto review inspects outer run_code (AR1)'
export const AUTO_REVIEW_FALLBACK_MARKER = 'dsh-mobile auto review withdraws to workspace-write (AR1)'
export const AUTO_REVIEW_HIGH_DENY_MARKER = 'dsh-mobile auto review hard-denies high risk (AR1)'
export const AUTO_REVIEW_HIGH_GUARD_MARKER = 'dsh-mobile auto review high-risk denial is monotonic (AR1)'
export const PERMISSION_AUTO_UI_MARKER = 'dsh-mobile auto review default confirmation (AR1)'
export const AUTO_REVIEW_RESTORE_MARKER = 'dsh-mobile restores Auto sessions before reviewer registration (AR1)'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} anchor missing or ambiguous`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function replaceOnceInSection(source, sectionStart, sectionEnd, before, after, label) {
  const start = source.indexOf(sectionStart)
  const end = source.indexOf(sectionEnd, start + sectionStart.length)
  if (start < 0 || end < 0 || source.indexOf(sectionStart, start + sectionStart.length) >= 0) {
    throw new Error(`${label} section missing or ambiguous`)
  }
  const section = source.slice(start, end)
  const patched = replaceOnce(section, before, after, label)
  return source.slice(0, start) + patched + source.slice(end)
}

export function patchPermissionPresetsAutoDefault(source) {
  if (source.includes(PERMISSION_AUTO_DEFAULT_MARKER)) {
    for (const marker of [
      '[...Object.keys(this.presets), AUTO_PRESET].map((name) => this.optionOf(name))',
      'return this.presets[name] ?? (name === AUTO_PRESET ? AUTO_PRESET_SPEC : void 0);',
      'this.autoAdmit?.();',
      AUTO_REVIEW_RESTORE_MARKER,
      'const restoreSpec = preset === AUTO_PRESET ? this.resolve(AUTO_PRESET) : void 0;',
      'restoreSpec?.sandbox ?? this.ctx.shell.sandboxMode',
      'restoreSpec?.approval ?? this.ctx.approval.config.policy ?? "ask"',
      'this.permissionState(agent.session).preset === AUTO_PRESET',
      'Auto review integration is unavailable; tool execution was blocked.',
    ]) if (!source.includes(marker)) throw new Error('partial permission Auto default patch detected: ' + marker)
    return source
  }
  let out = source
  out = replaceOnce(out,
    '\t\t\tconst defaultPreset = config.defaultPreset.get() ?? inferredDefault;\n\t\t\tif (defaultPreset === "custom") throw new Error("permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly");\n\t\t\tthis.resolve(defaultPreset);',
    '\t\t\tconst defaultPreset = config.defaultPreset.get() ?? inferredDefault;\n\t\t\tif (defaultPreset === "custom") throw new Error("permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly");\n\t\t\tthis.resolve(defaultPreset);\n\t\t\t// ' + PERMISSION_AUTO_DEFAULT_MARKER + ': Auto is a fixed preset; execution stays blocked until its reviewer registers.',
    'permission default startup-order patch')
  if (!out.includes(PERMISSION_AUTO_DEFAULT_MARKER) || !out.includes('this.resolve(defaultPreset);')) {
    throw new Error('permission default startup-order patch verification failed')
  }
  out = replaceOnce(out,
    '\t\t\t\tif (!Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`);',
    '\t\t\t\tif (defaultPreset !== AUTO_PRESET && !Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`);',
    'permission default availability')
  out = replaceOnce(out,
    '\t\t\t\tdefaultOptions: Object.keys(this.presets).map((name) => this.optionOf(name)),',
    '\t\t\t\tdefaultOptions: [...Object.keys(this.presets), AUTO_PRESET].map((name) => this.optionOf(name)),',
    'permission default catalog')
  out = replaceOnce(out,
    '\t\t\t\tthis.autoAdmit = admit;\n\t\t\t\tthis.emitCatalogChanged();',
    '\t\t\t\tthis.autoAdmit = admit;\n\t\t\t\tfor (const session of this.ctx.sessions.list()) this.pinInitialPermission(session);\n\t\t\t\tthis.emitCatalogChanged();',
    'permission auto registration')
  out = replaceOnce(out,
    '\t\t\tif (preset === "auto") {\n\t\t\t\tif (this.autoAdmit === void 0) throw new Error("permission: cannot restore preset \\"auto\\" without its active integration");\n\t\t\t\tthis.autoAdmit();\n\t\t\t}',
    '\t\t\t// ' + AUTO_REVIEW_RESTORE_MARKER + ': restore durable Auto state before registration; the execution guard blocks it until review is live.\n\t\t\tif (preset === AUTO_PRESET) this.autoAdmit?.();',
    'permission auto restoration')
  out = replaceOnce(out,
    '\t\t\treturn this.presets[name] ?? (name === "auto" && this.autoAdmit !== void 0 ? AUTO_PRESET_SPEC : void 0);',
    '\t\t\treturn this.presets[name] ?? (name === AUTO_PRESET ? AUTO_PRESET_SPEC : void 0);',
    'permission Auto preset specification')
  out = replaceOnce(out,
    '\t\t\tif (sandbox === null) setSandboxMode(session, this.ctx.shell.sandboxMode);\n\t\t\tif (approval === null) setApprovalPolicy(session, this.ctx.approval.config.policy ?? "ask");',
    '\t\t\tconst restoreSpec = preset === AUTO_PRESET ? this.resolve(AUTO_PRESET) : void 0;\n\t\t\tif (sandbox === null) setSandboxMode(session, restoreSpec?.sandbox ?? this.ctx.shell.sandboxMode);\n\t\t\tif (approval === null) setApprovalPolicy(session, restoreSpec?.approval ?? this.ctx.approval.config.policy ?? "ask");',
    'persisted Auto permission facts')
  out = replaceOnce(out,
    '\t\t\tctx.on("session/created", (session) => {\n\t\t\t\tthis.pinInitialPermission(session);\n\t\t\t});',
    '\t\t\tctx.on("session/created", (session) => {\n\t\t\t\tthis.pinInitialPermission(session);\n\t\t\t});\n\t\t\tctx.on("tools/pre-execute", (exec, next) => {\n\t\t\t\tconst agent = exec.agent;\n\t\t\t\tif (agent !== void 0 && (this.permissionState(agent.session).preset === AUTO_PRESET || this.current(agent.session) === AUTO_PRESET) && this.autoAdmit === void 0) return { kind: "deny", reason: "Auto review integration is unavailable; tool execution was blocked." };\n\t\t\t\treturn next();\n\t\t\t}, { prepend: true });',
    'permission Auto fail-closed guard')
  if (!out.includes('for (const session of this.ctx.sessions.list()) this.pinInitialPermission(session);')
    || !out.includes('this.names.map((name) => this.optionOf(name))')
    || !out.includes('this.autoAdmit?.();')
    || !out.includes(AUTO_REVIEW_RESTORE_MARKER)
    || !out.includes('restoreSpec?.sandbox ?? this.ctx.shell.sandboxMode')
    || !out.includes('restoreSpec?.approval ?? this.ctx.approval.config.policy ?? "ask"')
    || !out.includes('this.permissionState(agent.session).preset === AUTO_PRESET')
    || !out.includes('Auto review integration is unavailable; tool execution was blocked.')) {
    throw new Error('permission Auto default patch verification failed')
  }
  return out
}

export function patchAutoReviewDefaultBehavior(source) {
  const autoReviewMarkers = [AUTO_REVIEW_RUN_CODE_MARKER, AUTO_REVIEW_FALLBACK_MARKER, AUTO_REVIEW_HIGH_DENY_MARKER, AUTO_REVIEW_HIGH_GUARD_MARKER]
  if (autoReviewMarkers.some((marker) => source.includes(marker))) {
    for (const marker of autoReviewMarkers) if (!source.includes(marker)) throw new Error('partial Auto review behavior patch detected: ' + marker)
    for (const invariant of [
      'if (agent === void 0) return next();',
      'permissionPresets.set(session, "workspace-write");',
      'if (decision.risk === "high") {',
      'hardDenied.set(exec, decision.reason ?? "high-risk action");',
      'yield ctx.tools.guard((exec) => {',
    ]) if (!source.includes(invariant)) throw new Error('partial Auto review behavior patch detected: ' + invariant)
    if (source.includes('exec.parent === void 0 && exec.name === RUN_CODE_NAME')) throw new Error('partial Auto review behavior patch detected: outer run_code exclusion remains')
    return source
  }
  let out = source
  out = replaceOnce(out,
    '\t\t\tif (agent === void 0 || exec.parent === void 0 && exec.name === RUN_CODE_NAME) return next();',
    '\t\t\t// ' + AUTO_REVIEW_RUN_CODE_MARKER + ': review PTC source before direct Node effects can run.\n\t\t\tif (agent === void 0) return next();',
    'Auto review outer run_code gate')
  out = replaceOnce(out,
    '\t\t\t\t\tpermissionPresets.set(session, "danger-full-access");',
    '\t\t\t\t\t// ' + AUTO_REVIEW_FALLBACK_MARKER + ': the reviewer is gone, so restore the fail-closed Android shell mode.\n\t\t\t\t\tpermissionPresets.set(session, "workspace-write");',
    'Auto review withdrawal fallback')
  out = replaceOnce(out,
    '\t\t\t\tconst { decision } = review;\n\t\t\t\tif (decision.decision === "deny" && ctx.approval.overrideOf(agent.session) === "never") return denied(exec, decision.reason);',
    '\t\t\t\tconst { decision } = review;\n\t\t\t\tif (decision.risk === "high") {\n\t\t\t\t\t// ' + AUTO_REVIEW_HIGH_DENY_MARKER + ': the hard-deny class cannot be approved by a user.\n\t\t\t\t\thardDenied.set(exec, decision.reason ?? "high-risk action");\n\t\t\t\t\treturn denied(exec, decision.reason);\n\t\t\t\t}\n\t\t\t\tif (decision.decision === "deny" && ctx.approval.overrideOf(agent.session) === "never") return denied(exec, decision.reason);',
    'Auto review high-risk hard denial')
  out = replaceOnce(out,
    '\tconst active = /* @__PURE__ */ new Set();\n\tconst lifecycle = new AbortController();',
    '\tconst active = /* @__PURE__ */ new Set();\n\tconst hardDenied = new WeakMap();\n\tconst lifecycle = new AbortController();',
    'Auto review hard-denial state')
  out = replaceOnce(out,
    '\tctx.effect(function* () {\n\t\tyield ctx.on("tools/pre-execute", async (exec, next) => {',
    '\tctx.effect(function* () {\n\t\tyield ctx.tools.guard((exec) => {\n\t\t\tconst reason = hardDenied.get(exec);\n\t\t\treturn reason === void 0 ? void 0 : `Auto review hard-denied this high-risk call: ${reason}`;\n\t\t});\n\t\t// ' + AUTO_REVIEW_HIGH_GUARD_MARKER + ': later hooks cannot restore an allow decision.\n\t\tyield ctx.on("tools/pre-execute", async (exec, next) => {',
    'Auto review monotonic high-risk guard')
  if (!out.includes(AUTO_REVIEW_RUN_CODE_MARKER) || !out.includes(AUTO_REVIEW_FALLBACK_MARKER)
    || !out.includes(AUTO_REVIEW_HIGH_DENY_MARKER) || !out.includes(AUTO_REVIEW_HIGH_GUARD_MARKER)
    || !out.includes('hardDenied.set(exec, decision.reason ?? "high-risk action");')
    || !out.includes('yield ctx.tools.guard((exec) => {') || out.includes('exec.parent === void 0 && exec.name === RUN_CODE_NAME')) {
    throw new Error('Auto review behavior patch verification failed')
  }
  return out
}

export function patchPermissionPresetsClientAutoDefault(source) {
  if (source.includes(PERMISSION_AUTO_UI_MARKER)) return source
  let out = source
  out = replaceOnce(out,
    '"auto.description": "无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。",',
    '"auto.description": "无文件路径沙箱；模型审查每次原生工具、PTC 外层程序及内层调用。",',
    'current-session Auto review Chinese description')
  out = replaceOnce(out,
    '"auto.confirm.description": "自动审查不使用沙箱。每次原生工具调用和 PTC 内层调用前，都会由与当前 agent 相同的模型进行审查；审查拒绝的调用由你批准或拒绝。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。",',
    '"auto.confirm.description": "Android 不提供路径级文件系统沙箱，工具在应用 UID 权限下运行。Auto 会话中模型审查每次原生工具、PTC 外层程序及内层调用。低风险可能自动执行，中风险拒绝可请求用户确认；高风险拒绝和审查失败是硬拒绝，用户无法放行。切换当前会话的权限档位会停用 Auto 审查。模型仍可能误判并消耗额外 token；子 agent 可能按其权限策略直接拒绝。",',
    'current-session Auto review Chinese confirmation')
  out = replaceOnce(out,
    '"auto.description": "Run without a sandbox after an experimental same-model review of every native tool call and PTC inner call.",',
    '"auto.description": "No file path sandbox; the model reviews native tools, outer PTC programs, and inner calls.",',
    'current-session Auto review English description')
  out = replaceOnce(out,
    '"auto.confirm.description": "Auto review runs without a sandbox. Before every native tool call and PTC inner call, the same model as the current agent reviews whether to allow it; you approve or reject each call it denies. This feature is experimental, can falsely allow or deny actions, and uses additional tokens.",',
    '"auto.confirm.description": "Android provides no path-level filesystem sandbox; tools run with the app UID access. Auto sessions review each native tool, outer PTC program, and inner call. Low-risk calls may run automatically; medium-risk denials can ask for your approval. High-risk denials and review failures are hard-denied and cannot be approved. Changing the current session\'s permission preset disables Auto review. The model may misclassify actions and uses extra tokens; child agents may apply non-interactive approval policy.",',
    'current-session Auto review English confirmation')
  out = replaceOnceInSection(out, 'const zh = {', 'const en = {',
    '\t\t\t"preset.fullAccess": "完全权限",',
    '\t\t\t"preset.fullAccess": "完全权限",\n\t\t\t"preset.auto": "自动审查",\n\t\t\t"auto.defaultDescription": "新会话以 Full access 运行，无文件路径沙箱；每次原生工具、PTC 外层程序和内层调用前都会由当前 agent 的模型审查。",\n\t\t\t"auto.confirm.title": "将自动审查设为新会话默认权限？",\n\t\t\t"auto.confirm.description": "Android 不提供路径级文件系统沙箱，工具在应用 UID 权限下运行。Auto 会话中低风险调用可自动执行，中风险拒绝会请求用户确认；高风险拒绝和审查失败均为硬拒绝，用户无法放行。切换当前会话的权限档位会停用 Auto 审查。模型仍可能误判，审查会消耗额外 token；子 agent 的拒绝也可能因其权限策略而不可确认。",\n\t\t\t"auto.confirm.acknowledge": "我已了解这些风险，并愿意继续",\n\t\t\t"auto.confirm.enable": "设为默认权限",',
    'settings Auto review Chinese copy')
  out = replaceOnceInSection(out, 'const en = {', 'const accessZh = {',
    '\t\t\t"preset.fullAccess": "Full access",',
    '\t\t\t"preset.fullAccess": "Full access",\n\t\t\t"preset.auto": "Auto review",\n\t\t\t"auto.defaultDescription": "New sessions run with Full access and no file path sandbox. The current agent model reviews native tools, outer PTC programs, and inner PTC calls.",\n\t\t\t"auto.confirm.title": "Set Auto review as the default for new sessions?",\n\t\t\t"auto.confirm.description": "Android provides no path-level filesystem sandbox; tools run with app UID access. In Auto sessions, low-risk calls may run automatically and medium-risk denials ask for human approval. High-risk denials and review failures are hard-denied and cannot be approved. Changing the current session\'s permission preset disables Auto review. The model may still misclassify actions and reviews use extra tokens; child agents may apply non-interactive approval policy.",\n\t\t\t"auto.confirm.acknowledge": "I understand these risks and want to continue",\n\t\t\t"auto.confirm.enable": "Set as default",',
    'settings Auto review English copy')
  out = replaceOnce(out,
    '\t\t\t[FULL_ACCESS_PRESET, "preset.fullAccess"]\n\t\t]);',
    '\t\t\t[FULL_ACCESS_PRESET, "preset.fullAccess"],\n\t\t\t[AUTO_REVIEW_PRESET, "preset.auto"]\n\t\t]);',
    'Auto review settings label')
  out = replaceOnce(out,
    '\t\t\t"preset.fullAccess": en["preset.fullAccess"]\n\t\t};',
    '\t\t\t"preset.fullAccess": en["preset.fullAccess"],\n\t\t\t"preset.auto": en["preset.auto"]\n\t\t};',
    'Auto review default label')
  out = replaceOnce(out,
    '\t\t\tconst [confirmingFullAccess, setConfirmingFullAccess] = (0, react.useState)(false);\n\t\t\tconst [acknowledged, setAcknowledged] = (0, react.useState)(false);',
    '\t\t\tconst [confirmingFullAccess, setConfirmingFullAccess] = (0, react.useState)(false);\n\t\t\tconst [confirmingAutoReview, setConfirmingAutoReview] = (0, react.useState)(false);\n\t\t\tconst [acknowledged, setAcknowledged] = (0, react.useState)(false);',
    'Auto review default confirmation state')
  out = replaceOnce(out,
    '\t\t\t\tsetConfirmingFullAccess(false);\n\t\t\t}, [state.status, state.writable]);',
    '\t\t\t\tsetConfirmingFullAccess(false);\n\t\t\t\tsetConfirmingAutoReview(false);\n\t\t\t}, [state.status, state.writable]);',
    'Auto review default confirmation reset')
  out = replaceOnce(out,
    'const busy = state.status === "loading" || state.status === "saving" || confirmingFullAccess;',
    'const busy = state.status === "loading" || state.status === "saving" || confirmingFullAccess || confirmingAutoReview;',
    'Auto review default confirmation busy state')
  out = replaceOnce(out,
    'const description = state.error ?? t("description");',
    'const description = state.error ?? (state.currentValue === AUTO_REVIEW_PRESET ? t("auto.defaultDescription") : t("description"));',
    'Auto review default risk description')
  out = replaceOnce(out,
    '\t\t\t\t\t\tif (id === "danger-full-access") {\n\t\t\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\t\t\tsetConfirmingFullAccess(true);\n\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tselect(id);',
    '\t\t\t\t\t\tif (id === "danger-full-access") {\n\t\t\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\t\t\tsetConfirmingFullAccess(true);\n\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tif (id === AUTO_REVIEW_PRESET) {\n\t\t\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\t\t\tsetConfirmingAutoReview(true);\n\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tselect(id);',
    'Auto review default choice gate')
  out = replaceOnce(out,
    '\t\t\t\t\tselect(FULL_ACCESS_PRESET);\n\t\t\t\t}\n\t\t\t})] });',
    '\t\t\t\t\tselect(FULL_ACCESS_PRESET);\n\t\t\t\t}\n\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.RiskConfirmation, {\n\t\t\t\topen: confirmingAutoReview,\n\t\t\t\ttitle: t("auto.confirm.title"),\n\t\t\t\tdescription: t("auto.confirm.description"),\n\t\t\t\tacknowledgeLabel: t("auto.confirm.acknowledge"),\n\t\t\t\tcancelLabel: t("confirm.cancel"),\n\t\t\t\tcloseLabel: t("close"),\n\t\t\t\tconfirmLabel: t("auto.confirm.enable"),\n\t\t\t\tacknowledged,\n\t\t\t\tdisabled: !state.writable || state.status === "saving",\n\t\t\t\tonAcknowledgedChange: setAcknowledged,\n\t\t\t\tonCancel: () => {\n\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\tsetConfirmingAutoReview(false);\n\t\t\t\t},\n\t\t\t\tonConfirm: () => {\n\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\tsetConfirmingAutoReview(false);\n\t\t\t\t\tselect(AUTO_REVIEW_PRESET);\n\t\t\t\t}\n\t\t\t})] });',
    'Auto review default confirmation surface')
  if (!out.includes(PERMISSION_AUTO_UI_MARKER)) {
    out = out.replace('function PermissionRow({ load, select, usePermission, t }) {',
      '// ' + PERMISSION_AUTO_UI_MARKER + ': persist Auto only after the explicit risk acknowledgement.\n\t\tfunction PermissionRow({ load, select, usePermission, t }) {')
  }
  if (!out.includes(PERMISSION_AUTO_UI_MARKER) || !out.includes('select(AUTO_REVIEW_PRESET);')) {
    throw new Error('Auto review settings UI patch verification failed')
  }
  return out
}
