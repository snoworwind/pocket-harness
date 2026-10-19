/** Match the installed application's exact service component inside bound-service facts. */
export function isAccessibilityBound(dump, appId = 'com.snoworwind.pocketharness') {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const component = new RegExp(`(?:^|[^A-Za-z0-9_.$])${escape(appId)}/com\\.dsharnessmobile\\.shell\\.DeviceControlService(?=$|[^A-Za-z0-9_.$])`)
  const blocks = String(dump).matchAll(/Bound services:\s*(\{[^}]*\}|\[[^\]]*\]|[^\r\n]*)/gi)
  return [...blocks].some((m) => component.test(m[1]))
}
