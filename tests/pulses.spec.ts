import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import { ChariowInvalidSignatureError } from '../src/errors.ts'
import { MemoryDedupeStore } from '../src/pulses.ts'
import { pulseRequest, sign } from './helpers.ts'

const SECRET = 'whsec_test_secret'

/**
 * A body shaped the way Chariow transmits it: compact, forward slashes
 * escaped, non-ASCII escaped as \uXXXX. Written as a literal on purpose —
 * re-serialising it is exactly the mistake these tests exist to catch.
 */
const RAW_BODY =
  '{"event":"successful.sale","sale":{"id":"sal_1"},"product":{"url":"https:\\/\\/store.example.com\\/p\\/cours"},"customer":{"name":"Ren\\u00e9e Ad\\u00e9"}}'

function chariow(overrides: Record<string, unknown> = {}) {
  return new Chariow({ apiKey: 'sk_live_test', pulseSecret: SECRET, ...overrides })
}

test.group('pulses | signature', () => {
  test('accepts a delivery signed over the raw body', ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET })
    const delivery = chariow().pulses.verify(ctx)

    assert.equal(delivery.event, 'successful.sale')
    assert.equal(delivery.pulseId, 'pulse_abc123')
    assert.equal(delivery.deliveryId, 'del_001')
    assert.isFalse(delivery.isTest)
  })

  test('a re-serialised body does not match — proving we hash the raw bytes', ({ assert }) => {
    const reSerialised = JSON.stringify(JSON.parse(RAW_BODY))

    assert.notEqual(reSerialised, RAW_BODY)
    assert.notEqual(sign(reSerialised, SECRET), sign(RAW_BODY, SECRET))

    const ctx = pulseRequest({
      rawBody: RAW_BODY,
      secret: SECRET,
      signature: sign(reSerialised, SECRET),
    })

    assert.throws(() => chariow().pulses.verify(ctx), /digest does not match/)
  })

  test('rejects a missing signature header', ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET, signature: '' })
    assert.throws(() => chariow().pulses.verify(ctx), /header is missing/)
  })

  test('rejects a wrong secret', ({ assert }) => {
    const ctx = pulseRequest({
      rawBody: RAW_BODY,
      secret: SECRET,
      signature: sign(RAW_BODY, 'whsec_wrong'),
    })

    assert.throws(() => chariow().pulses.verify(ctx), /digest does not match/)
  })

  test('rejects an unsupported scheme prefix', ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET, signature: 'md5=abcdef' })
    assert.throws(() => chariow().pulses.verify(ctx), /unsupported signature scheme/)
  })

  test('a truncated signature is rejected, not thrown on by timingSafeEqual', ({ assert }) => {
    const ctx = pulseRequest({
      rawBody: RAW_BODY,
      secret: SECRET,
      signature: sign(RAW_BODY, SECRET).slice(0, 20),
    })

    assert.throws(() => chariow().pulses.verify(ctx), ChariowInvalidSignatureError)
    assert.throws(() => chariow().pulses.verify(ctx), /digest does not match/)
  })

  test('rejects when no signing secret is configured', ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET })
    const instance = new Chariow({ apiKey: 'sk_live_test' })

    assert.throws(() => instance.pulses.verify(ctx), /no Pulse signing secret is configured/)
  })

  test('resolves a per-pulse secret from the x-pulse-id header', ({ assert }) => {
    const instance = chariow({
      pulseSecret: { pulse_one: 'whsec_one', pulse_two: 'whsec_two' },
    })

    const ctx = pulseRequest({
      rawBody: RAW_BODY,
      secret: 'whsec_two',
      pulseId: 'pulse_two',
    })

    assert.equal(instance.pulses.verify(ctx).pulseId, 'pulse_two')

    const wrongPulse = pulseRequest({
      rawBody: RAW_BODY,
      secret: 'whsec_two',
      pulseId: 'pulse_one',
    })

    assert.throws(() => instance.pulses.verify(wrongPulse), /digest does not match/)
  })

  test('reads the event from the signed body, not the unsigned header', ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET, event: 'failed.sale' })
    assert.equal(chariow().pulses.verify(ctx).event, 'successful.sale')
  })
})

test.group('pulses | handle', () => {
  test('runs the matching handler and answers 200', async ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET })
    let seen = ''

    await chariow().pulses.handle(ctx, {
      'successful.sale': async (payload) => {
        seen = payload.sale.id
      },
    })

    assert.equal(seen, 'sal_1')
    assert.equal(ctx.response.getStatus(), 200)
    assert.deepEqual(ctx.response.content?.[0], { received: true })
  })

  test('runs a handler once for a redelivered delivery id', async ({ assert }) => {
    const instance = chariow()
    let runs = 0

    const handlers = { 'successful.sale': async () => void runs++ }

    const first = pulseRequest({ rawBody: RAW_BODY, secret: SECRET, deliveryId: 'del_dup' })
    const second = pulseRequest({ rawBody: RAW_BODY, secret: SECRET, deliveryId: 'del_dup' })

    await instance.pulses.handle(first, handlers)
    await instance.pulses.handle(second, handlers)

    assert.equal(runs, 1)
    assert.equal(first.response.getStatus(), 200)
    assert.equal(second.response.getStatus(), 200)
    assert.deepEqual(second.response.content?.[0], { received: true, duplicate: true })
  })

  test('processes a dashboard test event that carries no delivery id', async ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET, deliveryId: null })
    let ran = false

    const delivery = await chariow().pulses.handle(ctx, {
      'successful.sale': async () => {
        ran = true
      },
    })

    assert.isTrue(ran)
    assert.isTrue(delivery.isTest)
    assert.isNull(delivery.deliveryId)
  })

  test('falls back to the wildcard handler', async ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET })
    let event = ''

    await chariow().pulses.handle(ctx, {
      'license.revoked': async () => {},
      '*': async (received) => {
        event = received
      },
    })

    assert.equal(event, 'successful.sale')
  })

  test('answers 200 for an event with no handler at all', async ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET })
    await chariow().pulses.handle(ctx, {})

    assert.equal(ctx.response.getStatus(), 200)
  })

  test('a throwing handler propagates so Chariow retries the delivery', async ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET })

    await assert.rejects(
      () =>
        chariow().pulses.handle(ctx, {
          'successful.sale': async () => {
            throw new Error('database is down')
          },
        }),
      'database is down'
    )
  })

  test('dedupe: false lets a redelivery run again', async ({ assert }) => {
    const instance = chariow({ dedupe: false })
    let runs = 0
    const handlers = { 'successful.sale': async () => void runs++ }

    await instance.pulses.handle(
      pulseRequest({ rawBody: RAW_BODY, secret: SECRET, deliveryId: 'del_x' }),
      handlers
    )
    await instance.pulses.handle(
      pulseRequest({ rawBody: RAW_BODY, secret: SECRET, deliveryId: 'del_x' }),
      handlers
    )

    assert.equal(runs, 2)
  })

  test('a custom dedupe store is used', async ({ assert }) => {
    const remembered: string[] = []
    const instance = chariow({
      dedupe: {
        seen: async (id: string) => remembered.includes(id),
        remember: async (id: string) => void remembered.push(id),
      },
    })

    await instance.pulses.handle(pulseRequest({ rawBody: RAW_BODY, secret: SECRET }), {})

    assert.deepEqual(remembered, ['del_001'])
  })
})

test.group('pulses | memory dedupe store', () => {
  test('remembers an id and forgets an unknown one', ({ assert }) => {
    const store = new MemoryDedupeStore()

    assert.isFalse(store.seen('del_1'))
    store.remember('del_1')
    assert.isTrue(store.seen('del_1'))
    assert.isFalse(store.seen('del_2'))
  })
})
