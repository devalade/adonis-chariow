import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import {
  ChariowNotFound,
  ChariowRateLimited,
  ChariowRequestFailed,
  ChariowResponseUnexpected,
  ChariowUnauthorized,
  ChariowValidationFailed,
} from '../src/failures.ts'
import { envelope, fakeFetch, license } from './helpers.ts'

const STORE = { id: 'str_1', name: 'My Store', description: null, logo_url: null, url: 'https://s.test', status: 'active' }

const CHECKOUT = {
  product_id: 'prd_1',
  email: 'buyer@example.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: { number: '97000000', country_code: '+229' },
}

function chariow(fetchImpl: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new Chariow({ apiKey: 'sk_live_test', fetch: fetchImpl, ...overrides })
}

test.group('client | requests', () => {
  test('unwraps the envelope and sends the bearer token', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: envelope(STORE) }])

    const store = await chariow(impl).store.get()

    assert.equal(store.name, 'My Store')
    assert.equal(calls[0].url, 'https://api.chariow.com/v1/store')
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      'Bearer sk_live_test'
    )
  })

  test('omits undefined query values', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: envelope({ data: [], pagination: { next_cursor: null, prev_cursor: null, has_more: false } }) },
    ])

    await chariow(impl).products.list({ per_page: 5, search: undefined, cursor: undefined })

    assert.equal(calls[0].url, 'https://api.chariow.com/v1/products?per_page=5')
  })

  test('encodes user-supplied path segments', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: envelope(license()) }])

    await chariow(impl).licenses.get('ABC 123/XYZ')

    assert.equal(calls[0].url, 'https://api.chariow.com/v1/licenses/ABC%20123%2FXYZ')
  })

  test('throws a typed failure and keeps the API message', async ({ assert }) => {
    const { impl } = fakeFetch([
      { status: 401, body: { message: 'Store API key is required', data: [], errors: [] } },
    ])

    await assert.rejects(() => chariow(impl).store.get(), /Store API key is required/)

    const { impl: notFound } = fakeFetch([
      { status: 404, body: { message: 'No query results', data: [], errors: [] } },
    ])

    try {
      await chariow(notFound).products.get('prd_missing')
      assert.fail('expected a not found failure')
    } catch (error) {
      assert.instanceOf(error, ChariowNotFound)
      assert.equal((error as ChariowNotFound).code, 'E_CHARIOW_NOT_FOUND')
      assert.equal((error as ChariowNotFound).status, 404)
      assert.equal((error as ChariowNotFound).operation, 'getProduct')
    }
  })

  test('keeps field errors on a 422', async ({ assert }) => {
    const { impl } = fakeFetch([
      {
        status: 422,
        body: {
          message: 'The given data was invalid.',
          data: [],
          errors: { email: ['The email field is required.'] },
        },
      },
    ])

    try {
      await chariow(impl).checkout.create(CHECKOUT)
      assert.fail('expected a validation failure')
    } catch (error) {
      assert.instanceOf(error, ChariowValidationFailed)
      assert.deepEqual((error as ChariowValidationFailed).errors, {
        email: ['The email field is required.'],
      })
    }
  })

  test('surfaces a non-JSON body as a request failure instead of crashing', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 502, text: '<html>Bad gateway</html>' }])

    try {
      await chariow(impl).store.get()
      assert.fail('expected a request failure')
    } catch (error) {
      assert.instanceOf(error, ChariowRequestFailed)
      assert.equal((error as ChariowRequestFailed).responseStatus, 502)
    }
  })

  test('wraps a network failure without assuming an Error was thrown', async ({ assert }) => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof globalThis.fetch

    await assert.rejects(() => chariow(impl).store.get(), /getaddrinfo ENOTFOUND/)

    const nonError = (async () => {
      throw 'a bare string'
    }) as unknown as typeof globalThis.fetch

    try {
      await chariow(nonError).store.get()
      assert.fail('expected a request failure')
    } catch (error) {
      assert.instanceOf(error, ChariowRequestFailed)
      assert.equal((error as ChariowRequestFailed).cause, 'a bare string')
    }
  })

  test('never puts the API key in a failure', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 401, body: { message: 'Store API key is required' } }])

    try {
      await chariow(impl, { apiKey: 'sk_live_super_secret' }).store.get()
      assert.fail('expected an unauthorized failure')
    } catch (error) {
      assert.notInclude(JSON.stringify(error), 'sk_live_super_secret')
      assert.notInclude((error as Error).message, 'sk_live_super_secret')
      assert.notInclude((error as Error).stack ?? '', 'sk_live_super_secret')
    }
  })
})

test.group('client | response parsing', () => {
  test('rejects a success body that is not an API envelope', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 200, text: '"just a string"' }])

    try {
      await chariow(impl).store.get()
      assert.fail('expected a response failure')
    } catch (error) {
      assert.instanceOf(error, ChariowResponseUnexpected)
    }
  })

  test('rejects a documented field going missing rather than handing back undefined', async ({
    assert,
  }) => {
    const { id: _dropped, ...withoutId } = license()
    const { impl } = fakeFetch([{ status: 200, body: envelope(withoutId) }])

    try {
      await chariow(impl).licenses.get('ABC-123')
      assert.fail('expected a response failure')
    } catch (error) {
      assert.instanceOf(error, ChariowResponseUnexpected)
      assert.deepInclude((error as ChariowResponseUnexpected).issues[0], { path: 'id' })
      assert.equal((error as ChariowResponseUnexpected).operation, 'getLicense')
    }
  })

  test('keeps fields Chariow adds that this package does not model', async ({ assert }) => {
    const { impl } = fakeFetch([
      { status: 200, body: envelope({ ...STORE, loyalty_programme: { tier: 'gold' } }) },
    ])

    const store = await chariow(impl).store.get()

    assert.deepEqual((store as Record<string, unknown>).loyalty_programme, { tier: 'gold' })
  })

  test('rejects a checkout payload the API would reject anyway', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: envelope({ step: 'payment' }) }])

    await assert.rejects(() =>
      chariow(impl).checkout.create({ ...CHECKOUT, email: 'not-an-email' })
    )

    assert.lengthOf(calls, 0, 'a malformed payload must not cost a round trip')
  })
})

test.group('client | retries', () => {
  test('retries a rate-limited read and honours Retry-After', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
      { status: 200, body: envelope(STORE) },
    ])

    const store = await chariow(impl).store.get()

    assert.equal(store.name, 'My Store')
    assert.lengthOf(calls, 2)
  })

  test('gives up after the configured attempts', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
    ])

    try {
      await chariow(impl, { retries: 1 }).store.get()
      assert.fail('expected a rate limit failure')
    } catch (error) {
      assert.instanceOf(error, ChariowRateLimited)
      assert.equal((error as ChariowRateLimited).retryAfter, 0)
    }

    assert.lengthOf(calls, 2)
  })

  test('never retries a checkout — a retried checkout is a duplicate sale', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
    ])

    await assert.rejects(() => chariow(impl).checkout.create(CHECKOUT))

    assert.lengthOf(calls, 1)
  })

  test('retries a 5xx read', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 500, body: { message: 'Server error' } },
      { status: 200, body: envelope(STORE) },
    ])

    await chariow(impl).store.get()
    assert.lengthOf(calls, 2)
  })

  test('does not retry a 4xx read', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 404, body: { message: 'Not found' } }])

    await assert.rejects(() => chariow(impl).products.get('prd_1'))
    assert.lengthOf(calls, 1)
  })
})

test.group('client | config', () => {
  test('rejects an empty API key with a pointer to the dashboard', ({ assert }) => {
    assert.throws(() => new Chariow({ apiKey: '' }), /app\.chariow\.com\/settings\/api/)
  })

  test('honours a custom base URL without doubling slashes', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: envelope(STORE) }])

    await chariow(impl, { baseUrl: 'https://api.example.test/v1/' }).store.get()

    assert.equal(calls[0].url, 'https://api.example.test/v1/store')
  })

  test('maps a 403 to the unauthorized failure', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 403, body: { message: 'Forbidden' } }])

    try {
      await chariow(impl).store.get()
      assert.fail('expected an unauthorized failure')
    } catch (error) {
      assert.instanceOf(error, ChariowUnauthorized)
      assert.equal((error as ChariowUnauthorized).responseStatus, 403)
    }
  })
})
