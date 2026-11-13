/** This guidance stays available even when optional Linux activation fails. */
export const LINUX_TOOL_GUIDANCE = [
  'The main bash environment is Android/Termux (Bionic), including its own packages and host paths.',
  'For Debian/glibc work, first call linux_environment_status; use linux_bash only when ready=true.',
  'Linux is optional and has separate packages and guest paths. Never guess its install path or treat a missing Linux tool as a reason to replace Termux.',
  'If Linux is absent or failed, explain phase/reason and ask the user to install or repair it in settings; continue Termux tasks with bash.',
].join(' ')

export const LINUX_PHASES = ['unavailable', 'absent', 'inactive', 'restoring', 'checking', 'automatic-check',
  'installing', 'reinstalling', 'uninstalling', 'busy', 'failed', 'unhealthy', 'ready'] as const
