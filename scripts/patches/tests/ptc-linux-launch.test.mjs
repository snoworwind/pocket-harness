// PTC must execute the same managed glibc Node inside the Debian guest.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
const root = resolve(import.meta.dirname, '../../..')
const profile = readFileSync(resolve(root, 'scripts/profile-web.cordis.patch.yml'), 'utf8')
const guest = readFileSync(resolve(root, 'app/src/main/java/com/snoworwind/pocketharness/LinuxGuestBoot.kt'), 'utf8')
function check(profileText, guestText) {
  const entry = /^- id: ptc-runtime\n([\s\S]*?)(?=^- |$(?![\s\S]))/m.exec(profileText)?.[1]
  assert.ok(entry, 'PTC runtime config missing')
  const lines = entry.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  assert.deepEqual(lines, ['config:', 'launch:', 'kind: node-script', 'executable: /opt/node/bin/node'])
  assert.match(guestText, /if \(it == "NODE"\) "\/opt\/node\/bin\/node"/)
  assert.match(guestText, /"-b", "\$\{instance.node.parentFile!!\.parentFile!!\.absolutePath\}:\/opt\/node"/)
  assert.match(guestText, /"\/usr\/bin\/env", "-i"/)
  assert.match(guestText, /"--expose-internals"/)
  assert.match(guestText, /"host loader environment cannot cross the guest boundary"/)
  assert.doesNotMatch(entry, /LD_LIBRARY_PATH|LD_PRELOAD|TERMUX_|libexec\/dsh-node|linker64/)
}
test('PTC and engine use the managed guest Node and isolated loader environment', () => check(profile, guest))
test('negative controls reject the retired wrapper, host linker and missing guest Node mount', () => {
  for (const executable of ['/data/data/com.snoworwind.pocketharness/files/usr/libexec/dsh-node', '/system/bin/linker64', '/usr/bin/node']) {
    assert.throws(() => check(profile.replace('executable: /opt/node/bin/node', 'executable: ' + executable), guest))
  }
  assert.throws(() => check(profile, guest.replace(':\/opt\/node"', ':\/missing-node"')))
  assert.throws(() => check(profile, guest.replace('"/usr/bin/env", "-i"', '"/usr/bin/env"')))
})
