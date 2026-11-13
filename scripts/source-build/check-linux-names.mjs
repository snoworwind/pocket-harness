#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = resolve(import.meta.dirname, '../..')
const read = path => readFileSync(resolve(ROOT, path), 'utf8')
export function checkLinuxNames(input) {
  assert.equal(input.packageName, '@dsh-android/dsh-shell-linux')
  assert.ok(input.pluginDirs.includes('dsh-shell-linux'))
  assert.ok(!input.pluginDirs.includes('dsh-shell-termux'))
  assert.match(input.executor, /export class LinuxBashExecutor/)
  assert.doesNotMatch(input.executor, /TermuxBashExecutor|TERMUX_VERSION|termuxVersion|pkg install/)
  assert.match(input.bridge, /name: 'android_linux_channel_exec'/)
  assert.doesNotMatch(input.bridge, /name: 'android_termux_channel_exec'/)
  assert.doesNotMatch(input.environment, /TERMUX__PREFIX|TERMUX_VERSION|termuxVersion/)
  assert.match(input.profile, /id: shell-linux/)
  assert.match(input.profile, /name: '@dsh-android\/dsh-shell-linux'/)
  assert.doesNotMatch(input.profile, /shell-termux|\/files\/usr|\/files\/home/)
  assert.match(input.console, /bash 已就绪（Debian Linux 环境）/)
  assert.match(input.guide, /正在准备内置 Linux 环境/)
  assert.equal(input.legacyConfigDirectory, false)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = {
    packageName: JSON.parse(read('dsh-shell-linux/package.json')).name,
    pluginDirs: JSON.parse(read('scripts/plugin-dirs.json')).dirs,
    executor: read('dsh-shell-linux/src/index.ts'),
    bridge: read('plugins/dsh-android-bridge/src/index.ts'),
    environment: read('plugins/dsh-android-linux-env/src/index.ts'),
    profile: read('scripts/profile-web.cordis.patch.yml'),
    console: read('app/src/main/java/com/snoworwind/pocketharness/ConsoleSession.kt'),
    guide: read('app/src/main/java/com/snoworwind/pocketharness/GuidePageRenderer.kt'),
    legacyConfigDirectory: existsSync(resolve(ROOT, 'scripts/snapshot-config')),
  }
  checkLinuxNames(input)
  if (process.argv.includes('--self-test')) {
    for (const bad of [
      { packageName: '@dsh-android/dsh-shell-termux' },
      { executor: input.executor.replace('export class LinuxBashExecutor', 'export class TermuxBashExecutor') },
      { bridge: input.bridge.replace("name: 'android_linux_channel_exec'", "name: 'android_termux_channel_exec'") },
      { environment: input.environment + '\n// TERMUX__PREFIX\n' },
      { profile: input.profile.replace('id: shell-linux', 'id: shell-termux') },
      { legacyConfigDirectory: true },
    ]) assert.throws(() => checkLinuxNames({ ...input, ...bad }))
  }
  console.log('Linux runtime names and guest paths verified')
}
