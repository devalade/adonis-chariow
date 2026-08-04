import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import type { CheckoutPayload } from '../src/schemas.ts'
import { contextWithBody, envelope, fakeFetch } from './helpers.ts'

const PAYLOAD: CheckoutPayload = {
  product_id: 'prd_abc',
  email: 'buyer@example.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: { number: '97000000', country_code: '+229' },
}

function okCheckout() {
  return fakeFetch([
    {
      status: 200,
      body: envelope({
        step: 'payment',
        message: null,
        purchase: { id: 'sal_1', status: 'awaiting_payment' },
        payment: { checkout_url: 'https://pay.chariow.com/x', transaction_id: 'txn_1' },
      }),
    },
  ])
}

function chariow(fetchImpl: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new Chariow({ apiKey: 'sk_live_test', fetch: fetchImpl, ...overrides })
}

test.group('checkout', () => {
  test('returns the payment URL', async ({ assert }) => {
    const { impl } = okCheckout()
    const result = await chariow(impl).checkout.create(PAYLOAD)

    assert.equal(result.step, 'payment')
    assert.equal(result.payment?.checkout_url, 'https://pay.chariow.com/x')
  })

  test('forwards the buyer IP from the HttpContext', async ({ assert }) => {
    const { impl, calls } = okCheckout()
    const ctx = contextWithBody('{}', { 'x-forwarded-for': '203.0.113.42' })

    await chariow(impl).checkout.create(PAYLOAD, ctx)

    const sent = JSON.parse(calls[0].init.body as string)
    assert.equal(sent.customer_ip, ctx.request.ip())
  })

  test('an explicit customer_ip wins over the context', async ({ assert }) => {
    const { impl, calls } = okCheckout()
    const ctx = contextWithBody('{}')

    await chariow(impl).checkout.create({ ...PAYLOAD, customer_ip: '198.51.100.7' }, ctx)

    assert.equal(JSON.parse(calls[0].init.body as string).customer_ip, '198.51.100.7')
  })

  test('fills payment_currency from the config', async ({ assert }) => {
    const { impl, calls } = okCheckout()

    await chariow(impl, { currency: 'XOF' }).checkout.create(PAYLOAD)

    assert.equal(JSON.parse(calls[0].init.body as string).payment_currency, 'XOF')
  })

  test('an explicit payment_currency wins over the config', async ({ assert }) => {
    const { impl, calls } = okCheckout()

    await chariow(impl, { currency: 'XOF' }).checkout.create({
      ...PAYLOAD,
      payment_currency: 'EUR',
    })

    assert.equal(JSON.parse(calls[0].init.body as string).payment_currency, 'EUR')
  })

  test('does not mutate the caller payload', async ({ assert }) => {
    const { impl } = okCheckout()
    const payload = { ...PAYLOAD }

    await chariow(impl, { currency: 'XOF' }).checkout.create(payload, contextWithBody('{}'))

    assert.isUndefined(payload.payment_currency)
    assert.isUndefined(payload.customer_ip)
  })
})
