import { test } from '@japa/runner'

import { Chariow } from '../src/chariow.ts'
import { fakeFetch } from './helpers.ts'

function page(ids: string[], next: string | null) {
  return {
    status: 200,
    body: {
      message: 'ok',
      data: {
        data: ids.map((id) => ({ id, name: id })),
        pagination: { next_cursor: next, prev_cursor: null, has_more: next !== null },
      },
      errors: [],
    },
  }
}

function chariow(fetchImpl: typeof globalThis.fetch) {
  return new Chariow({ apiKey: 'sk_live_test', fetch: fetchImpl })
}

test.group('pagination', () => {
  test('walks every page then stops', async ({ assert }) => {
    const { impl, calls } = fakeFetch([
      page(['prd_1', 'prd_2'], 'cursor_2'),
      page(['prd_3'], null),
    ])

    const ids: string[] = []
    for await (const product of chariow(impl).products.all({ per_page: 2 })) {
      ids.push(product.id)
    }

    assert.deepEqual(ids, ['prd_1', 'prd_2', 'prd_3'])
    assert.lengthOf(calls, 2)
    assert.notInclude(calls[0].url, 'cursor=')
    assert.include(calls[1].url, 'cursor=cursor_2')
    assert.include(calls[1].url, 'per_page=2')
  })

  test('stops when the API repeats a cursor instead of looping forever', async ({ assert }) => {
    const { impl, calls } = fakeFetch([page(['sal_1'], 'same'), page(['sal_2'], 'same')])

    const ids: string[] = []
    for await (const sale of chariow(impl).sales.all()) {
      ids.push(sale.id)
    }

    assert.deepEqual(ids, ['sal_1', 'sal_2'])
    assert.lengthOf(calls, 2)
  })

  test('handles a single empty page', async ({ assert }) => {
    const { impl } = fakeFetch([page([], null)])

    const ids: string[] = []
    for await (const customer of chariow(impl).customers.all()) {
      ids.push(customer.id)
    }

    assert.isEmpty(ids)
  })

  test('list() returns the page and its cursors', async ({ assert }) => {
    const { impl } = fakeFetch([page(['lic_1'], 'cursor_2')])

    const result = await chariow(impl).licenses.list({ status: 'active' })

    assert.lengthOf(result.data, 1)
    assert.equal(result.pagination.next_cursor, 'cursor_2')
    assert.isTrue(result.pagination.has_more)
  })
})
