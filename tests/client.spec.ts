import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import {
  ChariowNotFoundError,
  ChariowRateLimitError,
  ChariowRequestError,
  ChariowUnauthorizedError,
  ChariowValidationError,
} from '../src/errors.ts'
import { fakeFetch } from './helpers.ts'

function chariow(fetchImpl: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new Chariow({ apiKey: 'sk_live_test', fetch: fetchImpl, ...overrides })
}

test.group('client | requests', () => {
  test('unwraps the envelope and sends the bearer token', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { message: 'ok', data: { id: 'str_1', name: 'My Store' }, errors: [] } },
    ])

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
      { status: 200, body: { message: 'ok', data: { data: [], pagination: {} }, errors: [] } },
    ])

    await chariow(impl).products.list({ per_page: 5, search: undefined, cursor: undefined })

    assert.equal(calls[0].url, 'https://api.chariow.com/v1/products?per_page=5')
  })

  test('encodes user-supplied path segments', async ({ assert }) => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { message: 'ok', data: {}, errors: [] } }])

    await chariow(impl).licenses.get('ABC 123/XYZ')

    assert.equal(calls[0].url, 'https://api.chariow.com/v1/licenses/ABC%20123%2FXYZ')
  })

  test('throws a typed error and keeps the API message', async ({ assert }) => {
    const { impl } = fakeFetch([
      { status: 401, body: { message: 'Store API key is required', data: [], errors: [] } },
    ])

    await assert.rejects(() => chariow(impl).store.get(), /Store API key is required/)

    const { impl: notFound } = fakeFetch([
      { status: 404, body: { message: 'No query results', data: [], errors: [] } },
    ])

    try {
      await chariow(notFound).products.get('prd_missing')
      assert.fail('expected a not found error')
    } catch (error) {
      assert.instanceOf(error, ChariowNotFoundError)
      assert.equal((error as ChariowNotFoundError).code, 'E_CHARIOW_NOT_FOUND')
      assert.equal((error as ChariowNotFoundError).status, 404)
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
      await chariow(impl).checkout.create({
        product_id: 'prd_1',
        email: '',
        first_name: 'A',
        last_name: 'B',
        phone: { number: '1', country_code: '+229' },
      })
      assert.fail('expected a validation error')
    } catch (error) {
      assert.instanceOf(error, ChariowValidationError)
      assert.deepEqual((error as ChariowValidationError).errors, {
        email: ['The email field is required.'],
      })
    }
  })

  test('surfaces a non-JSON body as a request error instead of crashing', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 502, text: '<html>Bad gateway</html>' }])

    try {
      await chariow(impl).store.get()
      assert.fail('expected a request error')
    } catch (error) {
      assert.instanceOf(error, ChariowRequestError)
      assert.equal((error as ChariowRequestError).responseStatus, 502)
      assert.include((error as ChariowRequestError).message, 'Bad gateway')
    }
  })

  test('wraps a network failure', async ({ assert }) => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof globalThis.fetch

    await assert.rejects(() => chariow(impl).store.get(), /getaddrinfo ENOTFOUND/)
  })
})

test.group('client | retries', () => {
  test('retries a rate-limited read and honours Retry-After', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
      { status: 200, body: { message: 'ok', data: { id: 'str_1', name: 'Store' }, errors: [] } },
    ])

    const store = await chariow(impl).store.get()

    assert.equal(store.name, 'Store')
    assert.lengthOf(calls, 2)
  })

  test('gives up after the configured attempts', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
    ])

    try {
      await chariow(impl, { retries: 1 }).store.get()
      assert.fail('expected a rate limit error')
    } catch (error) {
      assert.instanceOf(error, ChariowRateLimitError)
      assert.equal((error as ChariowRateLimitError).retryAfter, 0)
    }

    assert.lengthOf(calls, 2)
  })

  test('never retries a checkout — a retried checkout is a duplicate sale', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { message: 'Rate limit exceeded' } },
    ])

    await assert.rejects(() =>
      chariow(impl).checkout.create({
        product_id: 'prd_1',
        email: 'a@b.co',
        first_name: 'A',
        last_name: 'B',
        phone: { number: '97000000', country_code: '+229' },
      })
    )

    assert.lengthOf(calls, 1)
  })

  test('retries a 5xx read', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      { status: 500, body: { message: 'Server error' } },
      { status: 200, body: { message: 'ok', data: { id: 'str_1', name: 'Store' }, errors: [] } },
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
    const { impl, calls } = fakeFetch([{ status: 200, body: { message: 'ok', data: {}, errors: [] } }])

    await chariow(impl, { baseUrl: 'https://api.example.test/v1/' }).store.get()

    assert.equal(calls[0].url, 'https://api.example.test/v1/store')
  })

  test('maps a 403 to the unauthorized error', async ({ assert }) => {
    const { impl } = fakeFetch([{ status: 403, body: { message: 'Forbidden' } }])

    try {
      await chariow(impl).store.get()
      assert.fail('expected an unauthorized error')
    } catch (error) {
      assert.instanceOf(error, ChariowUnauthorizedError)
    }
  })
})
