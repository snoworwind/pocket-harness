import { ADB_KEYBOARD_RECEIVER } from './ime-component.js'

/** A single result from the Android `am broadcast` command for the ADB keyboard. */
export type AdbKeyboardBroadcastStatus =
  | 'dispatched'
  | 'ime-not-ready'
  | 'source-rejected'
  | 'bad-request'
  | 'no-input-connection'
  | 'edit-unconfirmed'
  | 'unknown'

export const ADB_KEYBOARD_RESULT = {
  dispatched: 1,
  imeNotReady: 2,
  sourceRejected: 3,
  badRequest: 4,
  noInputConnection: 5,
  editUnconfirmed: 6,
} as const

/** Quote one argument for the Android shell without exposing spaces or metacharacters. */
export function quoteAdbShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Build exactly one explicitly addressed keyboard broadcast. */
export function buildAdbKeyboardBroadcast(
  action: 'ADB_INPUT_TEXT' | 'ADB_CLEAR_TEXT',
  msg: string | null,
  authArg: string,
): string {
  const parts = [`am broadcast -n ${ADB_KEYBOARD_RECEIVER} -a ${action}`]
  if (authArg.trim()) parts.push(authArg.trim())
  if (action === 'ADB_INPUT_TEXT' && msg !== null) parts.push(`--es msg ${quoteAdbShellArgument(msg)}`)
  return parts.join(' ')
}

/**
 * Parse exactly one shell broadcast result. Old shells commonly return 0, and
 * missing/truncated or unknown results are also unknown; none proves delivery.
 */
export function parseAdbKeyboardBroadcastResult(stdout: string): AdbKeyboardBroadcastStatus {
  const matches = [...(stdout ?? '').matchAll(/(?:^|\r?\n)Broadcast completed:\s*result=(-?\d+)(?=,|\s*$)/gm)]
  if (matches.length !== 1) return 'unknown'

  const code = Number.parseInt(matches[0][1], 10)
  switch (code) {
    case ADB_KEYBOARD_RESULT.dispatched: return 'dispatched'
    case ADB_KEYBOARD_RESULT.imeNotReady: return 'ime-not-ready'
    case ADB_KEYBOARD_RESULT.sourceRejected: return 'source-rejected'
    case ADB_KEYBOARD_RESULT.badRequest: return 'bad-request'
    case ADB_KEYBOARD_RESULT.noInputConnection: return 'no-input-connection'
    case ADB_KEYBOARD_RESULT.editUnconfirmed: return 'edit-unconfirmed'
    default: return 'unknown'
  }
}

/**
 * A clear with a legacy/unknown result may proceed only after a readback proves
 * that the field is currently empty. Explicit failures and partial edits stop.
 */
export function mayContinueAfterKeyboardClear(
  status: AdbKeyboardBroadcastStatus,
  clearReadback: string | null,
): boolean {
  return status === 'dispatched' || (status === 'unknown' && clearReadback === '')
}
