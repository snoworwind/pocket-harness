/**
 * Presentation strings for the experimental Linux environment settings section.
 *
 * Kept free of React so the wording and the state derivation can be tested
 * without a DOM (the release gate runs `node --test` with no UI dependencies).
 */

/** The experimental / not-enabled-yet statement shown at the top of the section. */
export const EXPERIMENTAL_NOTICE =
  '实验性插件（experimental）：这是我们自己的内部插件，已放入内置（hard）插件目录，但默认不启用。' +
  '只有你明确执行安装后，Linux 环境才会启用；' +
  '应用更新或 Linux 新版本发布都不会自动启用它。'

/**
 * Render the current Linux environment state as one line of user-facing text.
 *
 * @param {object|null|undefined} status - `linuxBootstrap.status()` payload.
 * @returns {string} State summary.
 */
export function describeVersionStatus(status) {
  if (!status) return '正在读取 Linux 环境状态…'
  if (!status.installed) {
    return status.updateBlocked
      ? '尚未安装 Linux 环境；发现较旧的 Linux 版本，已阻止降级'
      : '尚未安装 Linux 环境（实验性插件，默认不启用）'
  }
  const installed = `已安装 Linux 运行时 ${status.version}`
  const appVersion = status.mobileVersion ? `；当前 DSH Mobile ${status.mobileVersion}` : ''
  const baseline = status.installedSystemMobileVersion
    ? `（安装时 DSH Mobile ${status.installedSystemMobileVersion}）`
    : ''
  const activation = status.injectionActivated ? '' : '；插件已被移除或停用，自动更新已停止'
  if (status.updateAvailable) {
    return `${installed}${appVersion}${baseline}；可更新至 ${status.availableVersion}${activation}`
  }
  if (status.updateBlocked) {
    return `${installed}${appVersion}${baseline}；${status.error ?? '已阻止降级'}${activation}`
  }
  if (status.error) return `${installed}${appVersion}${baseline}；${status.error}${activation}`
  return `${installed}${appVersion}${baseline}${activation}`
}

/**
 * Whether the auto-update control should be operable.
 *
 * Auto-update is meaningless (and must stay off) until a Linux runtime is
 * actually installed and still injected.
 *
 * @param {object|null|undefined} status - `linuxBootstrap.status()` payload.
 * @returns {boolean} True when the control may be toggled.
 */
export function autoUpdateAvailable(status) {
  return Boolean(status?.installed)
}

/** Honest stage/byte progress; extraction and probes have no invented percentage or ETA. */
export function describeInstallProgress(status) {
  const progress = status?.progress
  if (!status?.busy && progress?.stage !== 'failed') return ''
  const labels = { download: '下载', extract: '解包', prepare: '准备运行环境', probe: '健康检查', failed: '失败', complete: '完成' }
  const bytes = progress?.stage === 'download' && Number.isFinite(progress.totalBytes) && progress.totalBytes > 0
    ? ` ${Math.floor((progress.receivedBytes ?? 0) / 1024 / 1024)} / ${Math.ceil(progress.totalBytes / 1024 / 1024)} MB` : ''
  const elapsed = progress?.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(progress.startedAt)) / 1000)) : 0
  const duration = Number.isFinite(elapsed) && elapsed > 0 ? `（已用 ${elapsed} 秒）` : ''
  const stage = progress?.stage === 'failed' && labels[progress.failedStage] ? `失败（${labels[progress.failedStage]}）` : labels[progress?.stage] ?? '处理中'
  return `${stage}${duration}${progress?.asset ? '：' + progress.asset : ''}${bytes}。首次安装通常需要数分钟，具体取决于网络和设备；无需重复点击。`
}
