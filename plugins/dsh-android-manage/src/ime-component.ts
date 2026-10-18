/** Compare Android flattened ComponentName values without accepting package substrings. */
function normalizeComponent(value: string): string | undefined {
  const text = value.trim()
  const separator = text.indexOf('/')
  if (separator <= 0 || separator === text.length - 1 || text.indexOf('/', separator + 1) !== -1) return undefined
  const packageName = text.slice(0, separator)
  const className = text.slice(separator + 1)
  if (!/^[A-Za-z0-9_.]+$/.test(packageName) || !/^\.?[A-Za-z0-9_.$]+$/.test(className)) return undefined
  return `${packageName}/${className.startsWith('.') ? packageName + className : className}`
}

export function isInputMethodEnabled(listOutput: string, expectedComponent: string): boolean {
  const expected = normalizeComponent(expectedComponent)
  if (!expected) return false
  return listOutput.split(/\r?\n/).some(line => normalizeComponent(line) === expected)
}
