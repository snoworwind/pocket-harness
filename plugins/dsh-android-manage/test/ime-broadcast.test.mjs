import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADB_KEYBOARD_RESULT,
  buildAdbKeyboardBroadcast,
  mayContinueAfterKeyboardClear,
  parseAdbKeyboardBroadcastResult,
  quoteAdbShellArgument,
} from '../lib/ime-broadcast.js'

test('parses each explicit keyboard result independently', () => {
  for (const [code, status] of [
    [ADB_KEYBOARD_RESULT.dispatched, 'dispatched'],
    [ADB_KEYBOARD_RESULT.imeNotReady, 'ime-not-ready'],
    [ADB_KEYBOARD_RESULT.sourceRejected, 'source-rejected'],
    [ADB_KEYBOARD_RESULT.badRequest, 'bad-request'],
    [ADB_KEYBOARD_RESULT.noInputConnection, 'no-input-connection'],
    [ADB_KEYBOARD_RESULT.editUnconfirmed, 'edit-unconfirmed'],
  ]) {
    assert.equal(parseAdbKeyboardBroadcastResult(`Broadcast completed: result=${code}, data=null`), status)
  }
})

test('default, absent, unknown and combined results never imply delivery', () => {
  for (const stdout of [
    'Broadcast completed: result=0',
    'Broadcast completed: result=-1, data=null',
    '',
    'Broadcast completed: result=7',
    'Broadcast completed: result=1\nBroadcast completed: result=1',
    'Broadcast completed: result=not-a-number',
  ]) {
    assert.equal(parseAdbKeyboardBroadcastResult(stdout), 'unknown')
  }
  assert.equal(parseAdbKeyboardBroadcastResult('Broadcast completed: result=1'), 'dispatched')
})

test('clear result allows input only when dispatch is confirmed or legacy output reads empty', () => {
  assert.equal(mayContinueAfterKeyboardClear('dispatched', null), true)
  assert.equal(mayContinueAfterKeyboardClear('unknown', ''), true)
  assert.equal(mayContinueAfterKeyboardClear('unknown', 'existing text'), false)
  assert.equal(mayContinueAfterKeyboardClear('unknown', null), false)
  assert.equal(mayContinueAfterKeyboardClear('edit-unconfirmed', ''), false)
  assert.equal(mayContinueAfterKeyboardClear('no-input-connection', ''), false)
})

test('broadcast command quotes text, carries auth, and names only the receiver component', () => {
  assert.equal(quoteAdbShellArgument("a'b"), "'a'\\''b'")
  assert.equal(
    buildAdbKeyboardBroadcast('ADB_INPUT_TEXT', "a'b $(id)", " --es auth 'nonce'"),
    "am broadcast -n com.snoworwind.pocketharness/com.snoworwind.pocketharness.AdbKeyboardReceiver -a ADB_INPUT_TEXT --es auth 'nonce' --es msg 'a'\\''b $(id)'",
  )
  assert.equal(
    buildAdbKeyboardBroadcast('ADB_CLEAR_TEXT', null, ''),
    'am broadcast -n com.snoworwind.pocketharness/com.snoworwind.pocketharness.AdbKeyboardReceiver -a ADB_CLEAR_TEXT',
  )
})
