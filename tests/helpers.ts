import { createHmac } from 'node:crypto'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'

import { HttpContextFactory, RequestFactory } from '@adonisjs/core/factories/http'
import type { HttpContext } from '@adonisjs/core/http'

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

  if (options.event) {
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
