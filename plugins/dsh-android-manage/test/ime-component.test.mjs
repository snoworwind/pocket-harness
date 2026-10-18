import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ADB_KEYBOARD_IME, ADB_KEYBOARD_RECEIVER, isInputMethodEnabled } from '../lib/ime-component.js'
import { apply } from '../lib/index.js'

test('package and class names match the retained Kotlin namespace and Android components', () => {
  for (const [component, name] of [[ADB_KEYBOARD_IME, 'AdbKeyboardService'], [ADB_KEYBOARD_RECEIVER, 'AdbKeyboardReceiver']]) {
    assert.equal(component, `com.snoworwind.pocketharness/com.dsharnessmobile.shell.${name}`)
    const source = readFileSync(new URL(`../../../app/src/main/java/com/dsharnessmobile/shell/${name}.kt`, import.meta.url), 'utf8')
    assert.match(source, /package com\.dsharnessmobile\.shell/)
  }
  assert.equal(isInputMethodEnabled(ADB_KEYBOARD_IME + '\r\nother/.Keyboard', ADB_KEYBOARD_IME), true)
  assert.equal(isInputMethodEnabled('pkg/.Keyboard', 'pkg/pkg.Keyboard'), true)
  for (const wrong of ['com.dsharnessmobile.shell/.AdbKeyboardService', 'com.snoworwind.pocketharness/.AdbKeyboardService', ADB_KEYBOARD_IME + '.old', 'xx' + ADB_KEYBOARD_IME]) {
    assert.equal(isInputMethodEnabled(wrong, ADB_KEYBOARD_IME), false)
  }
})

test('real env_prepare enables the exact IME and rejects old-package or unrelated list matches', async () => {
  for (const listed of [ADB_KEYBOARD_IME, 'com.dsharnessmobile.shell/.AdbKeyboardService', 'com.other/.AdbKeyboardService']) {
    const registered = [], calls = []
    const face = {
      gateFor: () => ({ ok: true }), audit: () => {},
      status: () => ({ adbChannel: true }),
      execAdbShell: async command => { calls.push(command); return { ok: true, stdout: command === 'ime list -s' ? listed : '' } },
    }
    apply({ tools: { register: tool => registered.push(tool) }, androidPrivilege: face, get: () => undefined, logger: () => ({ warn() {} }) })
    const tool = registered.find(tool => tool.name === 'android_env_prepare')
    const result = await tool.execute({ animations: false, ime: true }, { agent: { session: 'test' } })
    assert.equal(result.ok, listed === ADB_KEYBOARD_IME)
    assert.ok(calls.includes(`ime enable ${ADB_KEYBOARD_IME}`))
    assert.ok(calls.includes('ime list -s'))
    assert.equal(calls.some(command => command.includes('grep')), false)
  }
})
