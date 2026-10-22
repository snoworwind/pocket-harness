export const WORKSPACE_WRITE_WARNING_MARKER = 'dsh-mobile workspace-write warns about incomplete Android sandboxing (WW1)'

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

export function patchWorkspaceWriteBoundaryWarning(source) {
  if (source.includes(WORKSPACE_WRITE_WARNING_MARKER)) {
    for (const invariant of [
      'if (id === "danger-full-access" || id === "auto" || id === "workspace-write")',
      'confirmation === "workspace-write" ? t("workspaceWrite.confirm.title")',
      'state.currentValue === "workspace-write" ? t("workspaceWrite.defaultDescription")',
      'option.value === "workspace-write" ? { detail: t("workspaceWrite.description") }',
      'option.value === "workspace-write" ? { confirmation: {',
    ]) if (!source.includes(invariant)) throw new Error('partial Workspace Write warning patch detected: ' + invariant)
    return source
  }

  let out = source
  out = replaceOnceInSection(out, 'const zh = {', 'const en = {',
    '\t\t\t"preset.workspaceWrite": "工作区内修改",',
    '\t\t\t"preset.workspaceWrite": "工作区内修改",\n\t\t\t"workspaceWrite.defaultDescription": "Android 没有覆盖所有工具的路径级文件系统沙箱。Termux Shell 会在启动 bash 前拒绝此档位，因此无法通过它获得可用的工作区内 bash；其他原生工具和插件的实际访问范围取决于各自实现，不能保证只访问工作区。它们仍受 Android 应用 UID 权限边界约束。",\n\t\t\t"workspaceWrite.confirm.title": "“工作区内修改”不提供完整的工作区隔离",\n\t\t\t"workspaceWrite.confirm.description": "Android 没有覆盖所有工具的路径级文件系统沙箱。Termux Shell 会在启动 bash 前拒绝此档位，因此无法通过它获得可用的工作区内 bash；其他原生工具和插件的实际访问范围取决于各自实现，不能保证只访问工作区。它们仍受 Android 应用 UID 权限边界约束。",\n\t\t\t"workspaceWrite.confirm.acknowledge": "我已了解此档位不保证所有工具仅访问工作区",\n\t\t\t"workspaceWrite.confirm.enable": "仍使用此档位",',
    'Workspace Write settings warning copy')
  out = replaceOnceInSection(out, 'const en = {', 'const accessZh = {',
    '\t\t\t"preset.workspaceWrite": "Workspace Write",',
    '\t\t\t"preset.workspaceWrite": "Workspace Write",\n\t\t\t"workspaceWrite.defaultDescription": "Android does not provide a path-level filesystem sandbox that covers every tool. Termux Shell rejects this preset before starting bash, so it cannot provide a usable workspace-only shell; the actual access of other native tools and plugins depends on their implementations and cannot be guaranteed to stay within the workspace. They remain subject to the Android app UID boundary.",\n\t\t\t"workspaceWrite.confirm.title": "Workspace Write does not provide complete workspace isolation",\n\t\t\t"workspaceWrite.confirm.description": "Android does not provide a path-level filesystem sandbox that covers every tool. Termux Shell rejects this preset before starting bash, so it cannot provide a usable workspace-only shell; the actual access of other native tools and plugins depends on their implementations and cannot be guaranteed to stay within the workspace. They remain subject to the Android app UID boundary.",\n\t\t\t"workspaceWrite.confirm.acknowledge": "I understand this preset does not guarantee that every tool stays within the workspace",\n\t\t\t"workspaceWrite.confirm.enable": "Use this preset anyway",',
    'Workspace Write settings English warning copy')
  out = replaceOnceInSection(out, 'const accessZh = {', 'const accessEn = {',
    '\t\t\t"preset.workspaceWrite": "工作区内修改",',
    '\t\t\t"preset.workspaceWrite": "工作区内修改",\n\t\t\t"workspaceWrite.description": "Android 没有覆盖所有工具的路径级文件系统沙箱；Termux Shell 会在启动 bash 前拒绝此档位，其他工具也不能保证只访问工作区。",\n\t\t\t"workspaceWrite.confirm.title": "“工作区内修改”不提供完整的工作区隔离",\n\t\t\t"workspaceWrite.confirm.description": "Android 没有覆盖所有工具的路径级文件系统沙箱。Termux Shell 会在启动 bash 前拒绝此档位，因此无法通过它获得可用的工作区内 bash；其他原生工具和插件的实际访问范围取决于各自实现，不能保证只访问工作区。它们仍受 Android 应用 UID 权限边界约束。",\n\t\t\t"workspaceWrite.confirm.acknowledge": "我已了解此档位不保证所有工具仅访问工作区",\n\t\t\t"workspaceWrite.confirm.enable": "仍使用此档位",',
    'Workspace Write session Chinese warning copy')
  out = replaceOnceInSection(out, 'const accessEn = {', '\t\t//#endregion',
    '\t\t\t"preset.workspaceWrite": "Workspace Write",',
    '\t\t\t"preset.workspaceWrite": "Workspace Write",\n\t\t\t"workspaceWrite.description": "Android has no path-level filesystem sandbox covering every tool; Termux Shell rejects this preset before bash starts, and other tools cannot be guaranteed to stay within the workspace.",\n\t\t\t"workspaceWrite.confirm.title": "Workspace Write does not provide complete workspace isolation",\n\t\t\t"workspaceWrite.confirm.description": "Android does not provide a path-level filesystem sandbox that covers every tool. Termux Shell rejects this preset before starting bash, so it cannot provide a usable workspace-only shell; the actual access of other native tools and plugins depends on their implementations and cannot be guaranteed to stay within the workspace. They remain subject to the Android app UID boundary.",\n\t\t\t"workspaceWrite.confirm.acknowledge": "I understand this preset does not guarantee that every tool stays within the workspace",\n\t\t\t"workspaceWrite.confirm.enable": "Use this preset anyway",',
    'Workspace Write session English warning copy')

  out = replaceOnce(out,
    'return option.value === "auto" ? t("auto.description") : option.description;',
    'return option.value === "auto" ? t("auto.description") : option.value === "workspace-write" ? t("workspaceWrite.description") : option.description;',
    'Workspace Write selector description')
  out = replaceOnce(out,
    'if (id === "danger-full-access" || id === "auto") {',
    'if (id === "danger-full-access" || id === "auto" || id === "workspace-write") {',
    'Workspace Write current-session confirmation gate')
  out = replaceOnce(out,
    'const confirmationTitle = confirmation === "auto" ? t("auto.confirm.title") : t("confirm.title");',
    'const confirmationTitle = confirmation === "auto" ? t("auto.confirm.title") : confirmation === "workspace-write" ? t("workspaceWrite.confirm.title") : t("confirm.title");',
    'Workspace Write confirmation title')
  out = replaceOnce(out,
    'const confirmationDescription = confirmation === "auto" ? t("auto.confirm.description") : t("confirm.description");',
    'const confirmationDescription = confirmation === "auto" ? t("auto.confirm.description") : confirmation === "workspace-write" ? t("workspaceWrite.confirm.description") : t("confirm.description");',
    'Workspace Write confirmation description')
  out = replaceOnce(out,
    'const confirmationAcknowledge = confirmation === "auto" ? t("auto.confirm.acknowledge") : t("confirm.acknowledge");',
    'const confirmationAcknowledge = confirmation === "auto" ? t("auto.confirm.acknowledge") : confirmation === "workspace-write" ? t("workspaceWrite.confirm.acknowledge") : t("confirm.acknowledge");',
    'Workspace Write confirmation acknowledgement')
  out = replaceOnce(out,
    'const confirmationEnable = confirmation === "auto" ? t("auto.confirm.enable") : t("confirm.enable");',
    'const confirmationEnable = confirmation === "auto" ? t("auto.confirm.enable") : confirmation === "workspace-write" ? t("workspaceWrite.confirm.enable") : t("confirm.enable");',
    'Workspace Write confirmation action')
  out = replaceOnce(out,
    'const description = state.error ?? (state.currentValue === AUTO_REVIEW_PRESET ? t("auto.defaultDescription") : t("description"));',
    'const description = state.error ?? (state.currentValue === "workspace-write" ? t("workspaceWrite.defaultDescription") : state.currentValue === AUTO_REVIEW_PRESET ? t("auto.defaultDescription") : t("description"));',
    'Workspace Write default description')
  out = replaceOnce(out,
    '\t\t\tconst [confirmingFullAccess, setConfirmingFullAccess] = (0, react.useState)(false);\n\t\t\tconst [confirmingAutoReview, setConfirmingAutoReview] = (0, react.useState)(false);\n\t\t\tconst [acknowledged, setAcknowledged] = (0, react.useState)(false);',
    '\t\t\tconst [confirmingFullAccess, setConfirmingFullAccess] = (0, react.useState)(false);\n\t\t\tconst [confirmingAutoReview, setConfirmingAutoReview] = (0, react.useState)(false);\n\t\t\tconst [confirmingWorkspaceWrite, setConfirmingWorkspaceWrite] = (0, react.useState)(false);\n\t\t\tconst [acknowledged, setAcknowledged] = (0, react.useState)(false);',
    'Workspace Write default confirmation state')
  out = replaceOnce(out,
    '\t\t\t\tsetConfirmingFullAccess(false);\n\t\t\t\tsetConfirmingAutoReview(false);\n\t\t\t}, [state.status, state.writable]);',
    '\t\t\t\tsetConfirmingFullAccess(false);\n\t\t\t\tsetConfirmingAutoReview(false);\n\t\t\t\tsetConfirmingWorkspaceWrite(false);\n\t\t\t}, [state.status, state.writable]);',
    'Workspace Write default confirmation reset')
  out = replaceOnce(out,
    'const busy = state.status === "loading" || state.status === "saving" || confirmingFullAccess || confirmingAutoReview;',
    'const busy = state.status === "loading" || state.status === "saving" || confirmingFullAccess || confirmingAutoReview || confirmingWorkspaceWrite;',
    'Workspace Write default busy state')
  out = replaceOnce(out,
    '\t\t\t\t\t\tif (id === "danger-full-access") {',
    '\t\t\t\t\t\tif (id === "workspace-write") {\n\t\t\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\t\t\tsetConfirmingWorkspaceWrite(true);\n\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tif (id === "danger-full-access") {',
    'Workspace Write default choice gate')
  out = replaceOnce(out,
    '\t\t\t\t\tselect(AUTO_REVIEW_PRESET);\n\t\t\t\t}\n\t\t\t})] });',
    '\t\t\t\t\tselect(AUTO_REVIEW_PRESET);\n\t\t\t\t}\n\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.RiskConfirmation, {\n\t\t\t\topen: confirmingWorkspaceWrite,\n\t\t\t\ttitle: t("workspaceWrite.confirm.title"),\n\t\t\t\tdescription: t("workspaceWrite.confirm.description"),\n\t\t\t\tacknowledgeLabel: t("workspaceWrite.confirm.acknowledge"),\n\t\t\t\tcancelLabel: t("confirm.cancel"),\n\t\t\t\tcloseLabel: t("close"),\n\t\t\t\tconfirmLabel: t("workspaceWrite.confirm.enable"),\n\t\t\t\tacknowledged,\n\t\t\t\tdisabled: !state.writable || state.status === "saving",\n\t\t\t\tonAcknowledgedChange: setAcknowledged,\n\t\t\t\tonCancel: () => {\n\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\tsetConfirmingWorkspaceWrite(false);\n\t\t\t\t},\n\t\t\t\tonConfirm: () => {\n\t\t\t\t\tsetAcknowledged(false);\n\t\t\t\t\tsetConfirmingWorkspaceWrite(false);\n\t\t\t\t\tselect("workspace-write");\n\t\t\t\t}\n\t\t\t})] });',
    'Workspace Write default confirmation surface')
  out = replaceOnce(out,
    '...option.value === "auto" ? { detail: t("auto.description") } : option.description !== void 0 ? { detail: option.description } : {},',
    '...option.value === "auto" ? { detail: t("auto.description") } : option.value === "workspace-write" ? { detail: t("workspaceWrite.description") } : option.description !== void 0 ? { detail: option.description } : {},',
    'Workspace Write command description')
  out = replaceOnce(out,
    '...option.value === "danger-full-access" || option.value === "auto" ? { confirmation: {\n\t\t\t\t\ttitle: t(option.value === "auto" ? "auto.confirm.title" : "confirm.title"),\n\t\t\t\t\tdescription: t(option.value === "auto" ? "auto.confirm.description" : "confirm.description"),\n\t\t\t\t\tacknowledgeLabel: t(option.value === "auto" ? "auto.confirm.acknowledge" : "confirm.acknowledge"),\n\t\t\t\t\tcancelLabel: t("confirm.cancel"),\n\t\t\t\t\tconfirmLabel: t(option.value === "auto" ? "auto.confirm.enable" : "confirm.enable")\n\t\t\t\t} } : {}',
    '...option.value === "danger-full-access" || option.value === "auto" || option.value === "workspace-write" ? { confirmation: {\n\t\t\t\t\ttitle: t(option.value === "auto" ? "auto.confirm.title" : option.value === "workspace-write" ? "workspaceWrite.confirm.title" : "confirm.title"),\n\t\t\t\t\tdescription: t(option.value === "auto" ? "auto.confirm.description" : option.value === "workspace-write" ? "workspaceWrite.confirm.description" : "confirm.description"),\n\t\t\t\t\tacknowledgeLabel: t(option.value === "auto" ? "auto.confirm.acknowledge" : option.value === "workspace-write" ? "workspaceWrite.confirm.acknowledge" : "confirm.acknowledge"),\n\t\t\t\t\tcancelLabel: t("confirm.cancel"),\n\t\t\t\t\tconfirmLabel: t(option.value === "auto" ? "auto.confirm.enable" : option.value === "workspace-write" ? "workspaceWrite.confirm.enable" : "confirm.enable")\n\t\t\t\t} } : {}',
    'Workspace Write command confirmation data')

  if (!out.includes(WORKSPACE_WRITE_WARNING_MARKER)) {
    out = out.replace('function PermissionSelect({ locked, select, usePermissionCatalog, useProjection, t }) {',
      '// ' + WORKSPACE_WRITE_WARNING_MARKER + ': do not imply path-level isolation on Android.\n\t\tfunction PermissionSelect({ locked, select, usePermissionCatalog, useProjection, t }) {')
  }
  if (!out.includes(WORKSPACE_WRITE_WARNING_MARKER)) throw new Error('Workspace Write warning marker insertion failed')
  return out
}
