import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskCredentialShapes } from '../lib/index.js'

/**
 * 坑 535（R3-24）：审计与 .live.ndjson 的凭据形状掩码。样本为真实形态（非编造格式），
 * 与壳侧 LogSanitizerTest 的口径一致：宁可多打码，不可漏打码。
 */

test('厂商密钥形态被打码', () => {
  assert.equal(maskCredentialShapes('curl -H "x: sk-abcdefghijklmnopqrstuvwxyz123456"'), 'curl -H "x: [redacted]"')
  assert.equal(maskCredentialShapes('export KEY=xai-aaaaaaaaaaaaaaaa'), 'export KEY=[redacted]')
  assert.equal(maskCredentialShapes('push ghp_0123456789abcdef0123456789abcdef0123456'), 'push [redacted]')
  assert.equal(maskCredentialShapes('github_pat_XXXXXXXXXXXXXXXXXX_yyyyy clone'), '[redacted] clone')
  assert.equal(maskCredentialShapes('https://maps.googleapis.com/?key=AIzaSyA-1234567890abcdefg'), 'https://maps.googleapis.com/?key=[redacted]')
  assert.equal(maskCredentialShapes('aws s3 ls --token AKIAIOSFODNN7EXAMPLE'), 'aws s3 ls --token [redacted]')
})

test('Bearer 与敏感键值被打码', () => {
  assert.equal(maskCredentialShapes('curl -H "Authorization: Bearer abc123"'), 'curl -H "Authorization: Bearer [redacted]"')
  assert.equal(maskCredentialShapes('api_key=hunter2crypto upload'), 'api_key=[redacted] upload')
  assert.equal(maskCredentialShapes('--password=p@ssw0rd'), '--password=[redacted]')
  assert.equal(maskCredentialShapes('token="abcdef123456"'), 'token="[redacted]"')
})

test('PEM 私钥整块被打码（含 JSON 转义形态）', () => {
  const raw = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nnext'
  const out = maskCredentialShapes(raw)
  assert.ok(!out.includes('MIIEowIBAAKCAQEA'))
  assert.ok(out.includes('[redacted-private-key]'))
  // 掩码发生在 stringify 之前（转义后掩码会打坏 JSON 结构）；这里验证 stringify(掩码结果) 是合法 JSON
  const line = JSON.stringify({ args: { command: maskCredentialShapes(raw) } })
  assert.ok(!line.includes('MIIEowIBAAKCAQEA'))
  assert.ok(JSON.parse(line).args.command.includes('[redacted-private-key]'))
})

test('非凭据内容不受影响（不过度打码）', () => {
  const plain = 'grep -rn "risk-sk-1" /data/data --include="*.yaml" | sort'
  assert.equal(maskCredentialShapes(plain), plain)
  assert.equal(maskCredentialShapes('am start -n pkg/.MainActivity --es msg hello'), 'am start -n pkg/.MainActivity --es msg hello')
})

test('空值安全', () => {
  assert.equal(maskCredentialShapes(''), '')
  assert.equal(maskCredentialShapes(undefined), '')
})
