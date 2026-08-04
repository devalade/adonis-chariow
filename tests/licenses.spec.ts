import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import { ChariowRateLimited } from '../src/failures.ts'
import { decideLicenseAccess } from '../src/license_access.ts'
import type { License } from '../src/schemas.ts'
import { envelope, fakeFetch, license, testClock } from './helpers.ts'

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
    title: 'a license both revoked and expired reads as revoked',
    license: { status: 'revoked', is_active: false, is_expired: true },
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
    license: { status: 'pending_activation', is_active: false },
    valid: false,
    reason: 'inactive',
  },
]

test.group('licenses | the access decision', () => {
  for (const testCase of cases) {
    test(`${testCase.title} resolves to ${testCase.reason ?? 'valid'}`, ({ assert }) => {
      const check = decideLicenseAccess(license(testCase.license))

      assert.equal(check.valid, testCase.valid)
      if (!check.valid) {
        assert.equal(check.reason, testCase.reason)
      }
    })
  }
})

test.group('licenses | check', () => {
  test('an active license passes through the API', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 200, body: envelope(license()) }])

    const check = await chariow(impl).licenses.check('ABC-123-XYZ-789')

    assert.isTrue(check.valid)
  })

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

  test('a rate limit throws rather than reading as "no licence"', async ({ assert }) => {
    const { impl } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
    ])

    try {
      await chariow(impl, { retries: 0 }).licenses.check('ABC')
      assert.fail('an outage must not be reported as an invalid licence')
    } catch (error) {
      assert.instanceOf(error, ChariowRateLimited)
    }
  })

  test('an unauthorized key throws', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 401, body: { message: 'Store API key is required' } }])

    await assert.rejects(() => chariow(impl).licenses.check('ABC'), /Store API key is required/)
  })
})

test.group('licenses | caching', () => {
  test('a second check inside the TTL issues no request', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: envelope(license()) }])

    const instance = chariow(impl)
    await instance.licenses.check('ABC-123')
    await instance.licenses.check('ABC-123')

    assert.lengthOf(calls, 1)
  })

  test('the cache expires once the TTL has passed', async ({ assert }) => {
    const clock = testClock()
    const { impl, calls } = fakeFetch([{ status: 200, body: envelope(license()) }])

    const instance = chariow(impl, { now: clock.now, licenseCacheTtl: 60_000 })

    await instance.licenses.check('ABC-123')
    clock.advance(59_000)
    await instance.licenses.check('ABC-123')
    assert.lengthOf(calls, 1)

    clock.advance(2_000)
    await instance.licenses.check('ABC-123')
    assert.lengthOf(calls, 2)
  })

  test('a zero TTL disables caching', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: envelope(license()) }])

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
      { status: 200, body: envelope(license()) },
      { status: 200, body: envelope(license({ status: 'revoked', is_active: false })) },
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
      { status: 200, body: envelope(license({ activated_at: '2026-03-01T00:00:00+00:00' })) },
    ])

    const instance = chariow(impl)
    await instance.licenses.activate('ABC-123', 'device-42')

    assert.equal(calls[0].url, 'https://api.chariow.com/v1/licenses/ABC-123/activate')
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { device_identifier: 'device-42' })

    await instance.licenses.check('ABC-123')
    assert.lengthOf(calls, 1)
  })
})
