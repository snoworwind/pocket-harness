import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { linuxAbi, LINUX_ABIS } from './linux-abi.mjs'

for (const abi of LINUX_ABIS) test(`ABI mapping agrees across JS and Python: ${abi}`, () => {
  const result = spawnSync('python3', ['-c', `import runpy,json; print(json.dumps(runpy.run_path('scripts/source-build/linux-abi.py')['linux_abi']('${abi}')))`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const python = JSON.parse(result.stdout), js = linuxAbi(abi)
  for (const [left, right] of Object.entries({ androidAbi: 'android_abi', debianArch: 'debian_arch', nodePlatform: 'node_platform', elfMachine: 'elf_machine', elfName: 'elf_name', gcc: 'gcc', readelf: 'readelf', qemu: 'qemu', rootfsAsset: 'rootfs_asset', prootBackendAsset: 'proot_asset', runtime: 'runtime', canvasBinding: 'canvas_binding', addonPackage: 'addon_package', baseId: 'base_id' })) assert.equal(js[left], python[right], left)
})

test('unknown ABI is rejected rather than defaulting to ARM64', () => {
  assert.throws(() => linuxAbi('amd64'), /unsupported/)
})

test('asset proof and cache key include both ABI mapping implementations', () => {
  const build = readFileSync(new URL('./build-linux-assets.sh', import.meta.url), 'utf8')
  const workflow = readFileSync(new URL('../../.github/workflows/build-apk-source.yml', import.meta.url), 'utf8')
  const check = (source, ci) => {
    const proof = source.split('SOURCE_PROOF_INPUTS=(')[1].split('\n)')[0]
    for (const name of ['linux-abi.mjs', 'linux-abi.py']) assert.ok(proof.includes(`scripts/source-build/${name}`))
    assert.equal((ci.match(/hashFiles\('scripts\/source-build\/run-linux-bootstrap\.py', 'scripts\/source-build\/linux-abi\.\*'/g) || []).length, 2)
    assert.ok(proof.includes('scripts/source-build/run-linux-bootstrap.py'))
    assert.ok(source.includes('sudo python3 scripts/source-build/run-linux-bootstrap.py "$ROOTFS"'))
    assert.ok(!source.includes('chroot "$ROOTFS" /debootstrap/debootstrap --second-stage'))
    assert.ok(source.includes('ELF_MACHINE=$(abi elfName)'))
    assert.ok(source.includes('grep -i "Machine:.*$ELF_MACHINE"'))
  }
  check(build, workflow)
  assert.throws(() => check(build.replace('scripts/source-build/linux-abi.py', ''), workflow))
  assert.throws(() => check(build, workflow.replaceAll("'scripts/source-build/linux-abi.*', ", '')))
  assert.throws(() => check(build.replace('sudo python3 scripts/source-build/run-linux-bootstrap.py "$ROOTFS"', 'sudo chroot "$ROOTFS" /debootstrap/debootstrap --second-stage'), workflow))
  assert.throws(() => check(build, workflow.replaceAll("'scripts/source-build/run-linux-bootstrap.py', ", '')))
})
