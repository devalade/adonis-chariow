import { createHmac } from 'node:crypto'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'

import { HttpContextFactory, RequestFactory } from '@adonisjs/core/factories/http'
import type { HttpContext } from '@adonisjs/core/http'

import type { License } from '../src/schemas.ts'

/**
 * Builds an HttpContext carrying a raw body and headers, the way the
 * bodyparser leaves it for a real JSON request.
 */
export function contextWithBody(rawBody: string, headers: Record<string, string> = {}): HttpContext {
  const req = new IncomingMessage(new Socket())
  req.headers = { 'content-type': 'application/json; charset=utf-8', ...headers }
  req.method = 'POST'
  req.url = '/webhooks/chariow'

  const request = new RequestFactory().merge({ req }).create()
  request.updateRawBody(rawBody)

  return new HttpContextFactory().merge({ request }).create()
}

/** Signs a body the way Chariow signs a Pulse delivery. */
export function sign(rawBody: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
}

/**
 * A signed Pulse delivery, ready to hand to `verify()` or `handle()`.
 */
export function pulseRequest(options: {
  rawBody: string
  secret: string
  pulseId?: string | null
  deliveryId?: string | null
  event?: string
  signature?: string
}): HttpContext {
  const headers: Record<string, string> = {}

  const signature = options.signature ?? sign(options.rawBody, options.secret)
  if (signature !== '') {
    headers['x-chariow-signature'] = signature
  }

  if (options.pulseId !== null) {
    headers['x-pulse-id'] = options.pulseId ?? 'pulse_abc123'
  }

  if (options.deliveryId !== null) {
    headers['x-pulse-delivery-id'] = options.deliveryId ?? 'del_001'
  }

  if (options.event !== undefined) {
    headers['x-pulse-event'] = options.event
  }

  return contextWithBody(options.rawBody, headers)
}

/**
 * A fetch double. Give it responses in the order they should be returned;
 * the last one repeats once the list is exhausted.
 */
export function fakeFetch(
  responses: { status: number; body?: unknown; headers?: Record<string, string>; text?: string }[]
) {
  const calls: { url: string; init: RequestInit }[] = []
  let index = 0

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })

    const spec = responses[Math.min(index, responses.length - 1)]
    index++

    const body = spec.text ?? (spec.body === undefined ? '' : JSON.stringify(spec.body))

    return new Response(body, {
      status: spec.status,
      headers: { 'content-type': 'application/json', ...spec.headers },
    })
  }) as unknown as typeof globalThis.fetch

  return { impl, calls }
}

/** Wraps a value in the API envelope Chariow sends. */
export function envelope(data: unknown, message = 'ok') {
  return { message, data, errors: [] }
}

/** A clock the test drives, so cache and de-duplication windows are observable. */
export function testClock(start = 1_000_000) {
  let current = start

  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
  }
}

/** A license that satisfies the response schema, overridable per test. */
export function license(overrides: Partial<License> = {}): License {
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
