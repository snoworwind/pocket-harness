// replace-once.mjs — fail closed when a patch anchor is missing or duplicated.

function labelOfString(anchor, label) {
  return label ?? anchor.slice(0, 60).replace(/\s+/g, ' ')
}

function countMatches(source, pattern) {
  if (pattern.sticky) throw new Error('replaceOnceRe: sticky anchors are not supported')
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const probe = new RegExp(pattern.source, flags)
  let hits = 0
  let match
  while ((match = probe.exec(source)) !== null) {
    hits += 1
    if (match[0] === '') {
      const codePoint = source.codePointAt(probe.lastIndex)
      probe.lastIndex += (pattern.unicode || pattern.unicodeSets) && codePoint !== undefined && codePoint > 0xffff ? 2 : 1
    }
  }
  return hits
}

function labelOfPattern(pattern, label) {
  return label ?? ('/' + pattern.source + '/' + pattern.flags).slice(0, 80)
}

function replaceRegex(source, pattern, after) {
  return source.replace(new RegExp(pattern.source, pattern.flags.replace(/g/g, '')), after)
}

/** Replace one literal anchor and reject both missing and duplicate matches. */
export function replaceOnce(source, before, after, label) {
  if (typeof before !== 'string' || before === '') {
    throw new Error('replaceOnce: anchor must be a non-empty string')
  }
  const hits = source.split(before).length - 1
  if (hits !== 1) {
    throw new Error(`anchor mismatch (expected exactly one occurrence, found ${hits}): ${labelOfString(before, label)}`)
  }
  return source.replace(before, after)
}

/** Replace a literal anchor when present once; absence is valid for upgrade paths. */
export function replaceAtMostOnce(source, before, after, label) {
  if (typeof before !== 'string' || before === '') {
    throw new Error('replaceAtMostOnce: anchor must be a non-empty string')
  }
  const hits = source.split(before).length - 1
  if (hits === 0) return source
  if (hits > 1) {
    throw new Error(`anchor mismatch (expected at most one occurrence, found ${hits}): ${labelOfString(before, label)}`)
  }
  return source.replace(before, after)
}

/** Replace one RegExp anchor and reject both missing and duplicate matches. */
export function replaceOnceRe(source, pattern, after, label) {
  if (!(pattern instanceof RegExp)) throw new Error('replaceOnceRe: anchor must be a RegExp')
  const hits = countMatches(source, pattern)
  if (hits !== 1) {
    throw new Error(`anchor mismatch (expected exactly one occurrence, found ${hits}): ${labelOfPattern(pattern, label)}`)
  }
  return replaceRegex(source, pattern, after)
}

/** Replace a RegExp anchor when present once; absence is valid for upgrade paths. */
export function replaceAtMostOnceRe(source, pattern, after, label) {
  if (!(pattern instanceof RegExp)) throw new Error('replaceAtMostOnceRe: anchor must be a RegExp')
  const hits = countMatches(source, pattern)
  if (hits === 0) return source
  if (hits > 1) {
    throw new Error(`anchor mismatch (expected at most one occurrence, found ${hits}): ${labelOfPattern(pattern, label)}`)
  }
  return replaceRegex(source, pattern, after)
}
