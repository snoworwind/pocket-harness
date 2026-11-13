#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXPECTED = new Map([
  ['libpocketharness_proot.so', { type: 3, interp: '/system/bin/linker64', entry: true }],
  ['libpocketharness_proot_loader.so', { type: 2, interp: null, entry: true }],
  ['libtalloc.so', { type: 3, interp: null, entry: false }],
  ['libandroid-shmem.so', { type: 3, interp: null, entry: false }],
])

function fail(message) { throw new Error(`Linux native library check: ${message}`) }

function parseElf(bytes, name, expected) {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46') fail(`${name} is not ELF`)
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) fail(`${name} must be 64-bit little-endian ELF`)
  if (bytes.readUInt16LE(16) !== expected.type || bytes.readUInt16LE(18) !== 183) fail(`${name} has an unexpected ELF type or architecture`)
  const entry = bytes.readBigUInt64LE(24)
  const phoff = Number(bytes.readBigUInt64LE(32))
  const phentsize = bytes.readUInt16LE(54)
  const phnum = bytes.readUInt16LE(56)
  if (phentsize < 56 || phnum < 1 || phoff + phentsize * phnum > bytes.length) fail(`${name} has an invalid program header table`)
  const interpreters = []
  let executableEntryMapped = false
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize
    const type = bytes.readUInt32LE(offset)
    if (type === 1) {
      const flags = bytes.readUInt32LE(offset + 4)
      const fileOffset = bytes.readBigUInt64LE(offset + 8)
      const virtualAddress = bytes.readBigUInt64LE(offset + 16)
      const fileSize = bytes.readBigUInt64LE(offset + 32)
      const memorySize = bytes.readBigUInt64LE(offset + 40)
      if (fileSize > memorySize || fileOffset + fileSize > BigInt(bytes.length)) fail(`${name} has an invalid PT_LOAD`)
      if (entry !== 0n && (flags & 1) !== 0 && entry >= virtualAddress && entry < virtualAddress + memorySize) executableEntryMapped = true
      continue
    }
    if (type !== 3) continue
    const offsetInFile = Number(bytes.readBigUInt64LE(offset + 8))
    const segmentSize = Number(bytes.readBigUInt64LE(offset + 32))
    if (segmentSize < 2 || offsetInFile + segmentSize > bytes.length) fail(`${name} has an invalid PT_INTERP`)
    interpreters.push(bytes.subarray(offsetInFile, offsetInFile + segmentSize).toString('utf8').replace(/\0+$/, ''))
  }
  if (expected.entry && (entry === 0n || !executableEntryMapped)) fail(`${name} entry point is not inside an executable PT_LOAD segment`)
  if (expected.interp === null ? interpreters.length !== 0 : interpreters.length !== 1 || interpreters[0] !== expected.interp) {
    fail(`${name} has an unexpected PT_INTERP (${interpreters.join(', ') || 'none'})`)
  }
}

export function checkLinuxNativeLibraries(directory) {
  const root = resolve(directory)
  const rootInfo = lstatSync(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('native library root must be a real directory')
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(['arm64-v8a'])) fail('native library root must contain only arm64-v8a')
  const abiDir = join(root, 'arm64-v8a')
  const abiInfo = lstatSync(abiDir)
  if (!abiInfo.isDirectory() || abiInfo.isSymbolicLink()) fail('arm64-v8a must be a real directory')
  if (JSON.stringify(readdirSync(abiDir).sort()) !== JSON.stringify([...EXPECTED.keys()].sort())) fail('unexpected ARM64 native library members')

  const files = []
  for (const [name, shape] of EXPECTED) {
    const file = join(abiDir, name)
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0 || info.size === 0 || info.size > 64 * 1024 * 1024) {
      fail(`${name} must be a bounded executable regular file`)
    }
    const bytes = readFileSync(file)
    parseElf(bytes, name, shape)
    files.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return { architecture: 'arm64', files }
}

function fixtureElf({ type, interp = null, entry = true }) {
  const phoff = 64
  const phentsize = 56
  const phnum = interp ? 2 : 1
  const interpBytes = interp ? Buffer.from(interp + '\0') : Buffer.alloc(0)
  const interpOffset = phoff + phentsize * phnum
  const bytes = Buffer.alloc(interpOffset + interpBytes.length)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(type, 16)
  bytes.writeUInt16LE(183, 18)
  bytes.writeBigUInt64LE(entry ? 0x40n : 0n, 24)
  bytes.writeBigUInt64LE(BigInt(phoff), 32)
  bytes.writeUInt16LE(phentsize, 54)
  bytes.writeUInt16LE(phnum, 56)
  bytes.writeUInt32LE(1, phoff)
  bytes.writeUInt32LE(5, phoff + 4)
  bytes.writeBigUInt64LE(0n, phoff + 8)
  bytes.writeBigUInt64LE(0n, phoff + 16)
  bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 32)
  bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 40)
  if (interp) {
    bytes.writeUInt32LE(3, phoff + phentsize)
    bytes.writeBigUInt64LE(BigInt(interpOffset), phoff + phentsize + 8)
    bytes.writeBigUInt64LE(BigInt(interpBytes.length), phoff + phentsize + 32)
    interpBytes.copy(bytes, interpOffset)
  }
  return bytes
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'linux-native-libraries-'))
  try {
    const libraries = join(root, 'native-libs')
    const abi = join(libraries, 'arm64-v8a')
    mkdirSync(abi, { recursive: true })
    for (const [name, shape] of EXPECTED) writeFileSync(join(abi, name), fixtureElf(shape))
    for (const name of EXPECTED.keys()) chmodSync(join(abi, name), 0o755)
    checkLinuxNativeLibraries(libraries)

    writeFileSync(join(abi, 'libpocketharness_proot_loader.so'), fixtureElf({ type: 3, interp: '/system/bin/linker64' }))
    let rejected = false
    try { checkLinuxNativeLibraries(libraries) } catch (error) { rejected = /unexpected ELF type/.test(error.message) || /unexpected PT_INTERP/.test(error.message) }
    if (!rejected) fail('self-test accepted a dynamic PRoot loader')
    console.log('PASS Linux native libraries: PRoot launcher, static loader, and dependency ELF shapes validated')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--self-test') selfTest()
    else {
      const result = checkLinuxNativeLibraries(process.argv[2] ?? '')
      for (const file of result.files) console.log(`${file.sha256} ${file.size} ${file.name}`)
      console.log(`PASS Linux native libraries: ${result.architecture}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
