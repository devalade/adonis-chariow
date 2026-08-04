import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import type { License, LicenseStatus } from '../src/types.ts'
import { fakeFetch } from './helpers.ts'

function license(overrides: Partial<License> = {}): License {
  return {
    id: 'lic_1',
    status: 'active',
    is_active: true,
    is_expired: false,
    can_activate: true,
    activations: { count: 1, max: 3, remaining: 2 },
    license: { key: 'ABC-123-XYZ-789', masked_key: 'ABC-***-***-789' },
    customer: { id: 'cus_1', name: 'Ada', email: 'ada@example.com' },
    product: { id: 'prd_1', name: 'Pro', slug: 'pro' },
    certificate_url: null,
    metadata: null,
    activated_at: null,
    expires_at: null,
    expired_at: null,
    revoked_at: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    ...overrides,
  }
}

function chariow(fetchImpl: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new Chariow({ apiKey: 'sk_live_test', fetch: fetchImpl, ...overrides })
}

const cases: {
  title: string
  license: Partial<License>
  valid: boolean
  reason?: string
}[] = [
  { title: 'an active license', license: {}, valid: true },
  {
    title: 'a revoked license',
    license: { status: 'revoked', is_active: false, revoked_at: '2026-02-01T00:00:00+00:00' },
    valid: false,
    reason: 'revoked',
  },
  {
    title: 'an expired license',
    license: { status: 'expired', is_active: false, is_expired: true },
    valid: false,
    reason: 'expired',
  },
  {
    title: 'a license flagged expired while still marked active',
    license: { is_expired: true },
    valid: false,
    reason: 'expired',
  },
  {
    title: 'a license awaiting activation',
    license: { status: 'pending_activation' as LicenseStatus, is_active: false },
    valid: false,
    reason: 'inactive',
  },
]

test.group('licenses | check', () => {
  for (const testCase of cases) {
    test(`${testCase.title} resolves to ${testCase.reason ?? 'valid'}`, async ({ assert }) => {
      const { impl } = fakeFetch([
        { status: 200, body: { message: 'ok', data: license(testCase.license), errors: [] } },
      ])

      const check = await chariow(impl).licenses.check('ABC-123-XYZ-789')

      assert.equal(check.valid, testCase.valid)
      if (!check.valid) {
        assert.equal(check.reason, testCase.reason)
        assert.isNotNull(check.license)
      }
    })
  }

  test('an unknown key resolves to not_found instead of throwing', async ({ assert }) => {
    const { impl } = fakeFetch([
      { status: 404, body: { message: 'No query results', data: [], errors: [] } },
    ])

    const check = await chariow(impl).licenses.check('NOPE')

    assert.isFalse(check.valid)
    if (!check.valid) {
      assert.equal(check.reason, 'not_found')
      assert.isNull(check.license)
    }
  })

  test('other failures still throw', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 401, body: { message: 'Store API key is required' } }])

    await assert.rejects(() => chariow(impl).licenses.check('ABC'), /Store API key is required/)
  })
})

test.group('licenses | caching', () => {
  test('a second check inside the TTL issues no request', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { message: 'ok', data: license(), errors: [] } },
    ])

    const instance = chariow(impl)
    await instance.licenses.check('ABC-123')
    await instance.licenses.check('ABC-123')

    assert.lengthOf(calls, 1)
  })

  test('a zero TTL disables caching', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { message: 'ok', data: license(), errors: [] } },
    ])

    const instance = chariow(impl, { licenseCacheTtl: 0 })
    await instance.licenses.check('ABC-123')
    await instance.licenses.check('ABC-123')

    assert.lengthOf(calls, 2)
  })

  test('a not_found result is not cached', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 404, body: { message: 'No query results' } }])

    const instance = chariow(impl)
    await instance.licenses.check('NOPE')
    await instance.licenses.check('NOPE')

    assert.lengthOf(calls, 2)
  })

  test('revoking refreshes the cached verdict', async ({ assert }) => {
    const { impl } = fakeFetch([
      { status: 200, body: { message: 'ok', data: license(), errors: [] } },
      {
        status: 200,
        body: {
          message: 'ok',
          data: license({ status: 'revoked', is_active: false }),
          errors: [],
        },
      },
    ])

    const instance = chariow(impl)
    assert.isTrue((await instance.licenses.check('ABC-123')).valid)

    await instance.licenses.revoke('ABC-123')

    const check = await instance.licenses.check('ABC-123')
    assert.isFalse(check.valid)
    if (!check.valid) {
      assert.equal(check.reason, 'revoked')
    }
  })

  test('activating sends the device identifier and refreshes the cache', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: { message: 'ok', data: license({ activated_at: '2026-03-01T00:00:00+00:00' }), errors: [] },
      },
    ])

    const instance = chariow(impl)
    await instance.licenses.activate('ABC-123', 'device-42')

    assert.equal(calls[0].url, 'https://api.chariow.com/v1/licenses/ABC-123/activate')
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { device_identifier: 'device-42' })

    await instance.licenses.check('ABC-123')
    assert.lengthOf(calls, 1)
  })
})
