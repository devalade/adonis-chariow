import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import { ChariowRateLimited } from '../src/failures.ts'
import type { License } from '../src/schemas.ts'
import { envelope, fakeFetch, license, pulseRequest, testClock } from './helpers.ts'

const DAY = 24 * 60 * 60 * 1000
const PULSE_SECRET = 'whsec_test_secret'

function chariow(fetchImpl: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new Chariow({
    apiKey: 'sk_live_test',
    pulseSecret: PULSE_SECRET,
    fetch: fetchImpl,
    ...overrides,
  })
}

/** A page envelope with no further pages. */
function page(items: unknown[]) {
  return {
    status: 200,
    body: envelope({
      data: items,
      pagination: { next_cursor: null, prev_cursor: null, has_more: false },
    }),
  }
}

function customer(overrides: Record<string, unknown> = {}) {
  return { id: 'cus_1', name: 'Ada Lovelace', email: 'ada@example.com', ...overrides }
}

function subscribed(days: number, overrides: Partial<License> = {}): License {
  return license({
    expires_at: new Date(Date.now() + days * DAY).toISOString(),
    customer: { id: 'cus_1', name: 'Ada Lovelace', email: 'ada@example.com' },
    product: { id: 'prd_pro', name: 'Pro', slug: 'pro' },
    ...overrides,
  })
}

test.group('subscriptions | forCustomer', () => {
  test('reports an active subscription from one request', async ({ assert }) => {
    const { impl, calls } = fakeFetch([page([subscribed(30)])])

    const subscription = await chariow(impl).subscriptions.forCustomer('cus_1', {
      product_id: 'prd_pro',
    })

    assert.equal(subscription.status, 'active')
    assert.isTrue(subscription.isActive)
    assert.lengthOf(calls, 1)
    assert.include(calls[0].url, '/licenses?')
    assert.include(calls[0].url, 'customer_id=cus_1')
    assert.include(calls[0].url, 'product_id=prd_pro')
  })

  test('a customer with no licences reads as none, not as an error', async ({ assert }) => {
    const { impl } = fakeFetch([page([])])

    const subscription = await chariow(impl).subscriptions.forCustomer('cus_1')

    assert.equal(subscription.status, 'none')
    assert.isFalse(subscription.isActive)
  })

  test('omitting product_id considers every product', async ({ assert }) => {
    const { impl, calls } = fakeFetch([page([subscribed(30)])])

    await chariow(impl).subscriptions.forCustomer('cus_1')

    assert.notInclude(calls[0].url, 'product_id')
  })

  test('an outage propagates rather than reading as "not subscribed"', async ({ assert }) => {
    const { impl } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
    ])

    try {
      await chariow(impl, { retries: 0 }).subscriptions.forCustomer('cus_1')
      assert.fail('an outage must not be reported as no subscription')
    } catch (error) {
      assert.instanceOf(error, ChariowRateLimited)
    }
  })

  test('walks every page of licences', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: envelope({
          data: [license({ status: 'expired', is_active: false, is_expired: true })],
          pagination: { next_cursor: 'cursor_2', prev_cursor: null, has_more: true },
        }),
      },
      page([subscribed(45)]),
    ])

    const subscription = await chariow(impl).subscriptions.forCustomer('cus_1')

    assert.equal(subscription.status, 'active', 'the live licence on page two must win')
    assert.lengthOf(calls, 2)
  })
})

test.group('subscriptions | forEmail', () => {
  test('resolves the email then the licences', async ({ assert }) => {
    const { impl, calls } = fakeFetch([page([customer()]), page([subscribed(30)])])

    const subscription = await chariow(impl).subscriptions.forEmail('ada@example.com', {
      product_id: 'prd_pro',
    })

    assert.equal(subscription.status, 'active')
    assert.lengthOf(calls, 2)
    assert.include(calls[0].url, '/customers?')
    assert.include(calls[1].url, 'customer_id=cus_1')
  })

  test('matches the email case-insensitively', async ({ assert }) => {
    const { impl } = fakeFetch([page([customer({ email: 'Ada@Example.com' })]), page([subscribed(30)])])

    const subscription = await chariow(impl).subscriptions.forEmail('  ADA@example.COM  ')

    assert.equal(subscription.status, 'active')
  })

  test('a search hit on the name only is not accepted as the customer', async ({ assert }) => {
    const { impl, calls } = fakeFetch([page([customer({ email: 'someone.else@example.com' })])])

    const subscription = await chariow(impl).subscriptions.forEmail('ada@example.com')

    assert.equal(subscription.status, 'none', 'a partial match must not hand over another account')
    assert.lengthOf(calls, 1, 'and must not go on to fetch that customer\'s licences')
  })

  test('an unknown email reads as none', async ({ assert }) => {
    const { impl } = fakeFetch([page([])])

    const subscription = await chariow(impl).subscriptions.forEmail('nobody@example.com')

    assert.equal(subscription.status, 'none')
  })
})

test.group('subscriptions | forLicense', () => {
  test('reports the standing of one key', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 200, body: envelope(subscribed(3)) }])

    const subscription = await chariow(impl).subscriptions.forLicense('ABC-123')

    assert.equal(subscription.status, 'expiring')
    assert.isTrue(subscription.renewalDue)
  })

  test('an unknown key reads as none instead of throwing', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 404, body: { message: 'No query results' } }])

    const subscription = await chariow(impl).subscriptions.forLicense('NOPE')

    assert.equal(subscription.status, 'none')
  })
})

test.group('subscriptions | caching', () => {
  test('a second lookup inside the TTL issues no request', async ({ assert }) => {
    const { impl, calls } = fakeFetch([page([subscribed(30)])])
    const instance = chariow(impl)

    await instance.subscriptions.forCustomer('cus_1', { product_id: 'prd_pro' })
    await instance.subscriptions.forCustomer('cus_1', { product_id: 'prd_pro' })

    assert.lengthOf(calls, 1)
  })

  test('the cache expires once the TTL has passed', async ({ assert }) => {
    const clock = testClock()
    const { impl, calls } = fakeFetch([page([subscribed(30)])])
    const instance = chariow(impl, { now: clock.now, subscriptionCacheTtl: 60_000 })

    await instance.subscriptions.forCustomer('cus_1')
    clock.advance(59_000)
    await instance.subscriptions.forCustomer('cus_1')
    assert.lengthOf(calls, 1)

    clock.advance(2_000)
    await instance.subscriptions.forCustomer('cus_1')
    assert.lengthOf(calls, 2)
  })

  test('days remaining stays honest inside a cache window', async ({ assert }) => {
    const clock = testClock(Date.parse('2026-06-01T00:00:00.000Z'))
    const { impl, calls } = fakeFetch([
      page([license({ expires_at: '2026-06-11T00:00:00.000Z' })]),
    ])
    const instance = chariow(impl, { now: clock.now, subscriptionCacheTtl: 10 * DAY })

    assert.equal((await instance.subscriptions.forCustomer('cus_1')).daysRemaining, 10)

    clock.advance(5 * DAY)

    const later = await instance.subscriptions.forCustomer('cus_1')
    assert.equal(later.daysRemaining, 5, 'the decision must be recomputed, not cached')
    assert.equal(later.status, 'expiring')
    assert.lengthOf(calls, 1, 'without re-fetching')
  })

  test('a zero TTL disables caching', async ({ assert }) => {
    const { impl, calls } = fakeFetch([page([subscribed(30)])])
    const instance = chariow(impl, { subscriptionCacheTtl: 0 })

    await instance.subscriptions.forCustomer('cus_1')
    await instance.subscriptions.forCustomer('cus_1')

    assert.lengthOf(calls, 2)
  })
})

test.group('subscriptions | renew', () => {
  test('checks out the same product for the same customer', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      page([subscribed(3)]),
      {
        status: 200,
        body: envelope({
          step: 'payment',
          payment: { checkout_url: 'https://pay.chariow.com/renew', transaction_id: 'txn_1' },
        }),
      },
    ])

    const instance = chariow(impl)
    const subscription = await instance.subscriptions.forCustomer('cus_1')

    const result = await instance.subscriptions.renew(subscription, {
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone: { number: '97000000', country_code: '+229' },
    })

    assert.equal(result.payment?.checkout_url, 'https://pay.chariow.com/renew')

    const sent = JSON.parse(calls[1].init.body as string)
    assert.equal(sent.product_id, 'prd_pro')
    assert.equal(sent.email, 'ada@example.com')
    assert.equal(sent.first_name, 'Ada')
  })

  test('an explicit email overrides the one on the licence', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      page([subscribed(3)]),
      { status: 200, body: envelope({ step: 'payment' }) },
    ])

    const instance = chariow(impl)
    const subscription = await instance.subscriptions.forCustomer('cus_1')

    await instance.subscriptions.renew(subscription, {
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone: { number: '97000000', country_code: '+229' },
      email: 'new@example.com',
    })

    assert.equal(JSON.parse(calls[1].init.body as string).email, 'new@example.com')
  })

  test('refuses to renew a standing with no licence', async ({ assert }) => {
    const { impl } = fakeFetch([page([])])
    const instance = chariow(impl)
    const subscription = await instance.subscriptions.forCustomer('cus_1')

    assert.throws(
      () =>
        instance.subscriptions.renew(subscription, {
          first_name: 'Ada',
          last_name: 'Lovelace',
          phone: { number: '97000000', country_code: '+229' },
        }),
      /Check `subscription.status`/
    )
  })

  test('renewing drops the cached standing', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      page([subscribed(3)]),
      { status: 200, body: envelope({ step: 'payment' }) },
      page([subscribed(365)]),
    ])

    const instance = chariow(impl)
    const before = await instance.subscriptions.forCustomer('cus_1')

    await instance.subscriptions.renew(before, {
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone: { number: '97000000', country_code: '+229' },
    })

    const after = await instance.subscriptions.forCustomer('cus_1')

    assert.equal(after.status, 'active')
    assert.lengthOf(calls, 3, 'the stale standing must not be served from cache')
  })
})

test.group('subscriptions | lifecycle', () => {
  function licensePulse(event: string, licenseOverrides: Partial<License> = {}) {
    return JSON.stringify({
      event,
      license: subscribed(3, licenseOverrides),
      product: { id: 'prd_pro', name: 'Pro' },
      customer: { id: 'cus_1', email: 'ada@example.com', name: 'Ada' },
      store: { id: 'str_1', name: 'Boutique' },
    })
  }

  test('a nearing-expiry delivery reaches onRenewalDue with the standing', async ({ assert }) => {
    const body = licensePulse('license.nearing_expiry')
    const ctx = pulseRequest({ rawBody: body, secret: PULSE_SECRET })
    const { impl } = fakeFetch([page([])])

    let seenDays: number | null = null
    let seenStatus = ''

    await chariow(impl).subscriptions.handle(ctx, {
      onRenewalDue: async (subscription) => {
        seenDays = subscription.daysRemaining
        seenStatus = subscription.status
      },
    })

    assert.equal(seenStatus, 'expiring')
    assert.equal(seenDays, 3)
    assert.equal(ctx.response.getStatus(), 200)
  })

  test('an expired delivery reaches onLapsed', async ({ assert }) => {
    const body = licensePulse('license.expired', {
      status: 'expired',
      is_active: false,
      is_expired: true,
    })
    const ctx = pulseRequest({ rawBody: body, secret: PULSE_SECRET })
    const { impl } = fakeFetch([page([])])

    let status = ''
    await chariow(impl).subscriptions.handle(ctx, {
      onLapsed: async (subscription) => {
        status = subscription.status
      },
    })

    assert.equal(status, 'expired')
  })

  test('a revoked delivery reaches onCancelled', async ({ assert }) => {
    const body = licensePulse('license.revoked', { status: 'revoked', is_active: false })
    const ctx = pulseRequest({ rawBody: body, secret: PULSE_SECRET })
    const { impl } = fakeFetch([page([])])

    let cancelled = false
    await chariow(impl).subscriptions.handle(ctx, {
      onCancelled: async () => {
        cancelled = true
      },
    })

    assert.isTrue(cancelled)
  })

  test('a redelivery runs the handler once', async ({ assert }) => {
    const body = licensePulse('license.expired', {
      status: 'expired',
      is_active: false,
      is_expired: true,
    })
    const { impl } = fakeFetch([page([])])
    const instance = chariow(impl)

    let runs = 0
    const handlers = { onLapsed: async () => void runs++ }

    await instance.subscriptions.handle(
      pulseRequest({ rawBody: body, secret: PULSE_SECRET, deliveryId: 'del_sub' }),
      handlers
    )
    await instance.subscriptions.handle(
      pulseRequest({ rawBody: body, secret: PULSE_SECRET, deliveryId: 'del_sub' }),
      handlers
    )

    assert.equal(runs, 1)
  })

  test('an invalid signature is still refused', async ({ assert }) => {
    const ctx = pulseRequest({
      rawBody: licensePulse('license.expired'),
      secret: PULSE_SECRET,
      signature: 'sha256=deadbeef',
    })
    const { impl } = fakeFetch([page([])])

    await assert.rejects(() => chariow(impl).subscriptions.handle(ctx, { onLapsed: async () => {} }))
  })

  test('a sale event on the same endpoint is answered and ignored', async ({ assert }) => {
    const body = JSON.stringify({
      event: 'successful.sale',
      sale: { id: 'sal_1' },
      product: { id: 'prd_pro', name: 'Pro' },
      customer: { id: 'cus_1', email: 'ada@example.com' },
      store: { id: 'str_1', name: 'Boutique' },
    })
    const ctx = pulseRequest({ rawBody: body, secret: PULSE_SECRET })
    const { impl } = fakeFetch([page([])])

    let ran = false
    await chariow(impl).subscriptions.handle(ctx, {
      onStarted: async () => {
        ran = true
      },
    })

    assert.isFalse(ran)
    assert.equal(ctx.response.getStatus(), 200)
  })
})
