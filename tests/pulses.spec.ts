import { Result } from 'better-result'
import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import { PulsePayloadUnexpected, PulseSignatureInvalid } from '../src/failures.ts'
import { MemoryDedupeStore } from '../src/pulses.ts'
import { pulseRequest, sign, testClock } from './helpers.ts'

const SECRET = 'whsec_test_secret'

/**
 * A body shaped the way Chariow transmits it: compact, forward slashes
 * escaped, non-ASCII escaped as \uXXXX. Written as a literal on purpose —
 * re-serialising it is exactly the mistake these tests exist to catch.
 */
const RAW_BODY =
  '{"event":"successful.sale","sale":{"id":"sal_1","status":"completed"},"product":{"id":"prd_1","name":"Cours","url":"https:\\/\\/store.example.com\\/p\\/cours"},"customer":{"id":"cus_1","email":"ren\\u00e9e@example.com","name":"Ren\\u00e9e Ad\\u00e9"},"store":{"id":"str_1","name":"Boutique"}}'

function chariow(overrides: Record<string, unknown> = {}) {
  return new Chariow({ apiKey: 'sk_live_test', pulseSecret: SECRET, ...overrides })
}

function refusal(ctx: ReturnType<typeof pulseRequest>) {
  const result = chariow().pulses.verify(ctx)
  if (Result.isOk(result)) {
    throw new Error('expected the delivery to be refused')
  }
  return result.error
}

test.group('pulses | signature', () => {
  test('accepts a delivery signed over the raw body', ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET })
    const result = chariow().pulses.verify(ctx)

    assert.isTrue(Result.isOk(result))
    if (Result.isOk(result)) {
      assert.equal(result.value.event, 'successful.sale')
      assert.equal(result.value.pulseId, 'pulse_abc123')
      assert.equal(result.value.deliveryId, 'del_001')
      assert.isFalse(result.value.isTest)
    }
  })

  test('a re-serialised body does not match — proving we hash the raw bytes', ({ assert }) => {
    const reSerialised = JSON.stringify(JSON.parse(RAW_BODY))

    assert.notEqual(reSerialised, RAW_BODY)
    assert.notEqual(sign(reSerialised, SECRET), sign(RAW_BODY, SECRET))

    const error = refusal(
      pulseRequest({ rawBody: RAW_BODY, secret: SECRET, signature: sign(reSerialised, SECRET) })
    )

    assert.instanceOf(error, PulseSignatureInvalid)
    if (error instanceof PulseSignatureInvalid) {
      assert.equal(error.reason, 'the digest does not match')
    }
  })

  test('rejects a missing signature header', ({ assert }) => {
    const error = refusal(pulseRequest({ rawBody: RAW_BODY, secret: SECRET, signature: '' }))
    assert.include(error.message, 'header is missing')
  })

  test('rejects a wrong secret', ({ assert }) => {
    const error = refusal(
      pulseRequest({ rawBody: RAW_BODY, secret: SECRET, signature: sign(RAW_BODY, 'whsec_wrong') })
    )
    assert.include(error.message, 'digest does not match')
  })

  test('rejects an unsupported scheme prefix', ({ assert }) => {
    const error = refusal(pulseRequest({ rawBody: RAW_BODY, secret: SECRET, signature: 'md5=abc' }))
    assert.include(error.message, 'unsupported signature scheme')
  })

  test('a truncated signature is refused, not thrown on by timingSafeEqual', ({ assert }) => {
    const error = refusal(
      pulseRequest({
        rawBody: RAW_BODY,
        secret: SECRET,
        signature: sign(RAW_BODY, SECRET).slice(0, 20),
      })
    )

    assert.instanceOf(error, PulseSignatureInvalid)
    assert.include(error.message, 'digest does not match')
  })

  test('refuses when no signing secret is configured', ({ assert }) => {
    const result = new Chariow({ apiKey: 'sk_live_test' }).pulses.verify(
      pulseRequest({ rawBody: RAW_BODY, secret: SECRET })
    )

    assert.isTrue(Result.isError(result))
    if (Result.isError(result)) {
      assert.include(result.error.message, 'no Pulse signing secret is configured')
    }
  })

  test('resolves a per-pulse secret from the x-pulse-id header', ({ assert }) => {
    const instance = chariow({ pulseSecret: { pulse_one: 'whsec_one', pulse_two: 'whsec_two' } })

    const matching = instance.pulses.verify(
      pulseRequest({ rawBody: RAW_BODY, secret: 'whsec_two', pulseId: 'pulse_two' })
    )
    assert.isTrue(Result.isOk(matching))

    const mismatched = instance.pulses.verify(
      pulseRequest({ rawBody: RAW_BODY, secret: 'whsec_two', pulseId: 'pulse_one' })
    )
    assert.isTrue(Result.isError(mismatched))
  })

  test('reads the event from the signed body, not the unsigned header', ({ assert }) => {
    const result = chariow().pulses.verify(
      pulseRequest({ rawBody: RAW_BODY, secret: SECRET, event: 'failed.sale' })
    )

    assert.isTrue(Result.isOk(result))
    if (Result.isOk(result)) {
      assert.equal(result.value.event, 'successful.sale')
    }
  })
})

test.group('pulses | payload parsing', () => {
  test('refuses a body that is not JSON', ({ assert }) => {
    const error = refusal(pulseRequest({ rawBody: 'not json at all', secret: SECRET }))
    assert.include(error.message, 'not valid JSON')
  })

  test('refuses an event name this package does not know', ({ assert }) => {
    const body = '{"event":"invented.event","sale":{"id":"sal_1"}}'
    const error = refusal(pulseRequest({ rawBody: body, secret: SECRET }))

    assert.instanceOf(error, PulsePayloadUnexpected)
    assert.include(error.message, 'no recognised event name')
  })

  test('refuses a known event whose payload is missing a documented field', ({ assert }) => {
    const body = '{"event":"successful.sale","sale":{"status":"completed"}}'
    const error = refusal(pulseRequest({ rawBody: body, secret: SECRET }))

    assert.instanceOf(error, PulsePayloadUnexpected)
    if (error instanceof PulsePayloadUnexpected) {
      assert.deepInclude(error.issues[0], { path: 'sale.id' })
    }
  })

  test('shape issues name the field but never the received value', ({ assert }) => {
    const body = '{"event":"successful.sale","sale":{"id":123,"secret_note":"card-4242"}}'
    const error = refusal(pulseRequest({ rawBody: body, secret: SECRET }))

    if (error instanceof PulsePayloadUnexpected) {
      assert.notInclude(JSON.stringify(error.issues), 'card-4242')
      assert.notInclude(JSON.stringify(error.issues), '123')
    }
  })

  test('keeps fields the package does not model yet', ({ assert }) => {
    const body = RAW_BODY.replace('{"event"', '{"brand_new_field":{"nested":true},"event"')
    const result = chariow().pulses.verify(pulseRequest({ rawBody: body, secret: SECRET }))

    assert.isTrue(Result.isOk(result))
    if (Result.isOk(result)) {
      assert.deepEqual(
        (result.value.payload as Record<string, unknown>).brand_new_field,
        { nested: true }
      )
    }
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

  test('throws the signature failure so AdonisJS renders a 401', async ({ assert }) => {
    const ctx = pulseRequest({ rawBody: RAW_BODY, secret: SECRET, signature: 'sha256=deadbeef' })

    try {
      await chariow().pulses.handle(ctx, {})
      assert.fail('expected handle to throw')
    } catch (error) {
      assert.instanceOf(error, PulseSignatureInvalid)
      assert.equal((error as PulseSignatureInvalid).status, 401)
      assert.equal((error as PulseSignatureInvalid).code, 'E_CHARIOW_INVALID_SIGNATURE')
    }
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

  test('forgets an id once the six-hour retry window has passed', ({ assert }) => {
    const clock = testClock()
    const store = new MemoryDedupeStore(clock.now)

    store.remember('del_1')

    clock.advance(5 * 60 * 60 * 1000)
    assert.isTrue(store.seen('del_1'), 'a retry three hours late must still be a duplicate')

    clock.advance(2 * 60 * 60 * 1000)
    assert.isFalse(store.seen('del_1'))
  })
})
