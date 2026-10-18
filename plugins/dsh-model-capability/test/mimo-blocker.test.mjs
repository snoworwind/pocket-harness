import assert from 'node:assert/strict'
import test from 'node:test'
import { canApplyReasoningEfforts, normalizeReasoningEfforts, pickDialect } from '../lib/index.js'

test('MiMo boolean thinking remains excluded from multi-effort serialization', () => {
  const api = 'openai-completions'
  const compat = { thinkingFormat: 'mimo', requiresReasoningContentOnAssistantMessages: true }
  assert.equal(canApplyReasoningEfforts(api, compat), false)
  assert.equal(normalizeReasoningEfforts(api, compat, { low: 'low', high: 'high' }, 'user-fallback'), undefined)
  assert.deepEqual(pickDialect(compat), compat)
})
