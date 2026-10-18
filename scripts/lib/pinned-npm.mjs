import { createHash } from 'node:crypto'

/** The source-controlled digest, never registry metadata, authorizes executable bytes. */
export function verifyPinnedNpm(bytes, name, version, pins) {
  const expected = pins?.[`${name}@${version}`]
  if (typeof expected !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected)) {
    throw new Error(`Missing SHA-512 pin for ${name}@${version}`)
  }
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (actual !== expected) throw new Error(`Pinned npm integrity mismatch: ${name}@${version}`)
}
