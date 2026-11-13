import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { LINUX_PHASES, LINUX_TOOL_GUIDANCE } from '../lib/linux-tool-contract.js'

test('Linux status and main-environment guidance survive an unavailable or failed runtime', async () => {
  const tools = new Map()
  const sections = []
  const ctx = {
    get(name) { return this[name] },
    tools: { register: tool => tools.set(tool.name, tool) },
    inject(names, activate) {
      if (!names.includes('systemPrompt')) return
      activate({ get(name) { return this[name] }, systemPrompt: { section: section => { sections.push(section); return () => {} } }, effect: register => register() })
    },
  }
  apply(ctx)
  const tool = tools.get('linux_environment_status')
  const absent = await tool.execute({})
  assert.equal(absent.phase, 'unavailable')
  assert.equal(absent.ready, false)
  assert.equal(absent.engine, 'termux')
  assert.deepEqual(tool.output.schema.properties.phase.enum, [...LINUX_PHASES])
  assert.equal(sections[0].text, LINUX_TOOL_GUIDANCE)
  assert.match(LINUX_TOOL_GUIDANCE, /bash.*Termux/)
  assert.match(LINUX_TOOL_GUIDANCE, /first call linux_environment_status/)
  ctx.linuxBootstrap = { status: async () => ({ installed: true, injectionActivated: false, error: 'controlled failure' }) }
  const failed = await tool.execute({})
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.ready, false)
  assert.equal(failed.reason, 'controlled failure')
  ctx.linuxBootstrap.status = async () => ({ installed: true, injectionActivated: true, runtime: { healthy: true } })
  assert.equal((await tool.execute({})).ready, true)
})
