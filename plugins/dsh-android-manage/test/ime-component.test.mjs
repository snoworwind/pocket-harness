import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInputMethodEnabled } from '../lib/ime-component.js'

const pocket = 'com.pocketharness.shell/.AdbKeyboardService'

test('recognizes only the requested IME component in short or expanded Android form', () => {
  assert.equal(isInputMethodEnabled(`${pocket}\ncom.other/.Keyboard`, pocket), true)
  assert.equal(isInputMethodEnabled('com.pocketharness.shell/com.pocketharness.shell.AdbKeyboardService', pocket), true)
})

test('does not accept the old app, another component, or substring matches', () => {
  assert.equal(isInputMethodEnabled('com.dsharnessmobile.shell/.AdbKeyboardService', pocket), false)
  assert.equal(isInputMethodEnabled('com.pocketharness.shell/.OtherService', pocket), false)
  assert.equal(isInputMethodEnabled('com.pocketharness.shell/.AdbKeyboardService.old', pocket), false)
  assert.equal(isInputMethodEnabled('xxcom.pocketharness.shell/.AdbKeyboardService', pocket), false)
})
