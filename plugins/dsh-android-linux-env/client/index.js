import React, { useEffect, useState } from 'react'
export const name = 'android-linux-environment-client'
export const inject = ['slots']
const h = React.createElement
export function LinuxEnvironmentSection() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function refresh() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/android/linux-environment/status', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`读取失败（${response.status}）`)
      setStatus(await response.json())
    } catch (error) { setError(String(error.message ?? error)) } finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])
  const check = status?.selfCheck
  const instance = status?.instance
  const rows = check ? [
    ['引擎 Node', `${check.engineNode?.version ?? '未知'} · ${check.engineNode?.path ?? ''}`],
    ['PATH Node', `${check.pathNode?.version ?? '不可用'} · ${check.pathNode?.path ?? ''}`],
    ['pnpm', `${check.pnpm?.version ?? '不可用'} · ${check.pnpm?.path ?? ''}`],
    ['npm 全局目录', check.npmGlobalPrefix ?? '未设置'],
    ['引擎 ripgrep', `${check.engineRipgrep?.version ?? '不可用'} · ${check.engineRipgrep?.path ?? ''}`],
    ['PATH ripgrep', `${check.pathRipgrep?.version ?? '不可用'} · ${check.pathRipgrep?.path ?? ''}`],
    ['Python / SOABI', `${check.python?.version ?? '不可用'} · ${check.python?.path ?? ''}`],
    ['原生构建工具', JSON.stringify(check.buildTools ?? {})],
    ['Node 额外 CA', `${check.ca?.nodeExtraCaCerts ?? '未设置'} · ${check.ca?.readable ? '可读' : '不可读'}`],
    ['宿主库隔离', check.libraryIsolation ? '宿主 loader 环境未进入客体' : '异常，请导出诊断'],
  ] : []
  return h('section', { 'aria-label': 'Linux 环境' },
    h('h3', null, 'Linux 环境'),
    h('p', null, '当前版本由壳侧 APK 内置 Debian。下载安装、独立更新和卸载按钮已停用；备份与重置请使用应用管理中心。'),
    h('button', { type: 'button', disabled: busy, onClick: refresh }, busy ? '正在读取…' : '刷新状态与自检'),
    error ? h('p', { role: 'alert' }, error) : null,
    h('p', null, `实例：${status?.installed ? '已安装' : '尚未提交'}；自检：${check?.ok ? '通过' : '待检查'}。自检针对引擎环境，交互 shell 的自定义 PATH 可能不同。`),
    h('table', null, h('tbody', null, ...rows.map(([label, value]) => h('tr', { key: label }, h('th', { scope: 'row' }, label), h('td', { style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, value))))),
    instance ? h('details', null, h('summary', null, '实例资产身份'), h('p', null, 'rootfs 摘要指首次铺底资产；用户 apt 改动不会重算或替换它。'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(instance, null, 2))) : null,
    h('p', null, '引擎搜索使用内置 ripgrep，命令行 rg 使用 apt 版本。Python minor/SOABI 变化后，应为新解释器重装用户原生扩展；旧文件保留在 home。'))
}
export function apply(ctx) {
  const register = () => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'linux-environment', order: 80, label: () => 'Linux 环境' }, LinuxEnvironmentSection))
  if (typeof ctx.effect === 'function') ctx.effect(register)
  else register()
}
