import { test } from '@japa/runner'
import { inspect } from 'node:util'

import { redact, Redacted } from '../src/redacted.ts'
import { resolveConfig } from '../src/define_config.ts'

const SECRET = 'sk_live_super_secret'

test.group('redacted', () => {
  test('reveals the secret only on request', ({ assert }) => {
    const wrapped = redact(SECRET)

    assert.equal(wrapped.reveal(), SECRET)
  })

  test('keeps the secret out of every accidental disclosure path', ({ assert }) => {
    const wrapped = redact(SECRET)

    assert.notInclude(String(wrapped), SECRET)
    assert.notInclude(`${wrapped}`, SECRET)
    assert.notInclude(JSON.stringify({ apiKey: wrapped }), SECRET)
    assert.notInclude(inspect(wrapped), SECRET)
    assert.notInclude(inspect({ nested: { apiKey: wrapped } }, { depth: 5 }), SECRET)
  })

  test('does not double-wrap', ({ assert }) => {
    const once = redact(SECRET)

    assert.strictEqual(redact(once), once)
  })

  test('resolveConfig wraps the credentials it is given', ({ assert }) => {
    const config = resolveConfig({ apiKey: SECRET, pulseSecret: 'whsec_1' })

    assert.instanceOf(config.apiKey, Redacted)
    assert.notInclude(JSON.stringify(config), SECRET)
    assert.notInclude(JSON.stringify(config), 'whsec_1')
    assert.equal(config.apiKey.reveal(), SECRET)
  })

  test('resolveConfig wraps every secret in a per-pulse map', ({ assert }) => {
    const config = resolveConfig({
      apiKey: SECRET,
      pulseSecret: { pulse_one: 'whsec_one', pulse_two: 'whsec_two' },
    })

    assert.notInclude(JSON.stringify(config), 'whsec_one')
    assert.notInclude(inspect(config, { depth: 5 }), 'whsec_two')
  })
})
