/** Installed application and Kotlin classes share the Pocket Harness namespace. */
export const ADB_KEYBOARD_IME = 'com.snoworwind.pocketharness/com.snoworwind.pocketharness.AdbKeyboardService'
export const ADB_KEYBOARD_RECEIVER = 'com.snoworwind.pocketharness/com.snoworwind.pocketharness.AdbKeyboardReceiver'

function normalizeComponent(value: string): string | undefined {
  const text = value.trim()
  const separator = text.indexOf('/')
  if (separator <= 0 || separator === text.length - 1 || text.indexOf('/', separator + 1) !== -1) return undefined
  const packageName = text.slice(0, separator), className = text.slice(separator + 1)
  if (!/^[A-Za-z0-9_.]+$/.test(packageName) || !/^\.?[A-Za-z0-9_.$]+$/.test(className)) return undefined
  return `${packageName}/${className.startsWith('.') ? packageName + className : className}`
}

export function isInputMethodEnabled(listOutput: string, expectedComponent: string): boolean {
  const expected = normalizeComponent(expectedComponent)
  return expected !== undefined && listOutput.split(/\r?\n/).some(line => normalizeComponent(line) === expected)
}
