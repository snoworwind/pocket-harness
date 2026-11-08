/**
 * Debian version comparison (deb-version(7), "Version" field ordering).
 *
 * Termux stable keeps several stanzas for one package name while a version is
 * retired, and both the Python signed-repo preparation and this builder must pick
 * the same record. The rule is the Debian ordering: epoch, then upstream version,
 * then revision, with `~` sorting before everything (including the empty string),
 * digit runs compared numerically and letters before punctuation.
 */

const DIGIT = /[0-9]/

/** dpkg's order(): `~` first, then letters, then every other character after them. */
function order(character) {
  if (character === '~') return -1
  if (character === undefined) return 0
  if (DIGIT.test(character)) return 0
  if (/[A-Za-z]/.test(character)) return character.charCodeAt(0)
  return character.charCodeAt(0) + 256
}

function splitVersion(value) {
  const text = String(value ?? '')
  const colon = text.indexOf(':')
  const epoch = colon < 0 ? 0 : Number(text.slice(0, colon)) || 0
  const rest = colon < 0 ? text : text.slice(colon + 1)
  const hyphen = rest.lastIndexOf('-')
  const upstream = hyphen < 0 ? rest : rest.slice(0, hyphen)
  const revision = hyphen < 0 ? '' : rest.slice(hyphen + 1)
  return { epoch, upstream, revision }
}

function comparePart(left, right) {
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    let firstDifference = 0
    while ((i < left.length && !DIGIT.test(left[i])) || (j < right.length && !DIGIT.test(right[j]))) {
      const a = order(i < left.length ? left[i] : undefined)
      const b = order(j < right.length ? right[j] : undefined)
      if (a !== b) return a - b
      i += 1
      j += 1
    }
    while (i < left.length && left[i] === '0') i += 1
    while (j < right.length && right[j] === '0') j += 1
    while (i < left.length && DIGIT.test(left[i]) && j < right.length && DIGIT.test(right[j])) {
      if (firstDifference === 0) firstDifference = left.charCodeAt(i) - right.charCodeAt(j)
      i += 1
      j += 1
    }
    if (i < left.length && DIGIT.test(left[i])) return 1
    if (j < right.length && DIGIT.test(right[j])) return -1
    if (firstDifference !== 0) return firstDifference
  }
  return 0
}

/** Returns <0, 0 or >0 exactly like dpkg --compare-versions. */
export function compareDebVersion(left, right) {
  const a = splitVersion(left)
  const b = splitVersion(right)
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  const upstream = comparePart(a.upstream, b.upstream)
  if (upstream !== 0) return upstream
  return comparePart(a.revision, b.revision)
}
