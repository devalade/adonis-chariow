import { createHmac, timingSafeEqual } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'

import type { PulseDedupeStore, ResolvedChariowConfig } from './define_config.ts'
import type { ChariowClient } from './client.ts'
import type { AnyPulsePayload, Page, Pulse, PulseEvent, PulseListParams, PulsePayloads } from './types.ts'
import { ChariowInvalidSignatureError } from './errors.ts'

/**
 * A verified Pulse delivery.
 */
export type PulseDelivery<E extends PulseEvent = PulseEvent> = {
  event: E
  /** From the `x-pulse-id` header. */
  pulseId: string | null
  /** From the `x-pulse-delivery-id` header. Absent on dashboard test events. */
  deliveryId: string | null
  payload: PulsePayloads[E]
  /** True for a test event sent from the dashboard (no delivery record). */
  isTest: boolean
}

type Handler<E extends PulseEvent> = (
  payload: PulsePayloads[E],
  delivery: PulseDelivery<E>
) => unknown | Promise<unknown>

/**
 * Handlers keyed by event, plus an optional `'*'` fallback for every event
 * without a specific handler.
 */
export type PulseHandlers = {
  [E in PulseEvent]?: Handler<E>
} & {
  '*'?: (
    event: PulseEvent,
    payload: AnyPulsePayload,
    delivery: PulseDelivery
  ) => unknown | Promise<unknown>
}

const SIGNATURE_HEADER = 'x-chariow-signature'
const SIGNATURE_PREFIX = 'sha256='

/**
 * Retries of the same delivery can land nearly three hours apart, so the
 * window has to comfortably exceed that.
 */
const DEDUPE_TTL = 6 * 60 * 60 * 1000
const DEDUPE_MAX_ENTRIES = 10_000

/**
 * Process-local de-duplication. Good enough for a single-process app; pass
 * your own store backed by Redis or a table when you run several.
 */
export class MemoryDedupeStore implements PulseDedupeStore {
  #entries = new Map<string, number>()

  seen(deliveryId: string): boolean {
    const expiresAt = this.#entries.get(deliveryId)

    if (expiresAt === undefined) {
      return false
    }

    if (expiresAt <= Date.now()) {
      this.#entries.delete(deliveryId)
      return false
    }

    return true
  }

  remember(deliveryId: string): void {
    this.#prune()
    this.#entries.set(deliveryId, Date.now() + DEDUPE_TTL)
  }

  #prune(): void {
    const now = Date.now()

    for (const [id, expiresAt] of this.#entries) {
      if (expiresAt <= now) {
        this.#entries.delete(id)
      }
    }

    /**
     * Hard cap so a flood of deliveries cannot grow the map without bound.
     * Map iterates in insertion order, so this drops the oldest first.
     */
    while (this.#entries.size > DEDUPE_MAX_ENTRIES) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) {
        break
      }
      this.#entries.delete(oldest.value)
    }
  }
}

/**
 * Reading Pulse configurations, and receiving their deliveries.
 */
export class PulsesResource {
  #client: ChariowClient
  #config: ResolvedChariowConfig
  #dedupe: PulseDedupeStore | false

  constructor(client: ChariowClient, config: ResolvedChariowConfig) {
    this.#client = client
    this.#config = config
    this.#dedupe = config.dedupe === false ? false : (config.dedupe ?? new MemoryDedupeStore())
  }

  /**
   * Lists the Pulses configured on the store.
   */
  list(params: PulseListParams = {}): Promise<Page<Pulse>> {
    return this.#client.get<Page<Pulse>>('/pulses', { ...params })
  }

  get(pulseId: string): Promise<Pulse> {
    return this.#client.get<Pulse>(`/pulses/${encodeURIComponent(pulseId)}`)
  }

  /**
   * Verifies that a request genuinely came from Chariow and returns the
   * delivery. Throws `ChariowInvalidSignatureError` (401) otherwise.
   *
   * Your endpoint URL is public, so anyone who finds it can post to it —
   * never act on a payload you have not verified.
   */
  verify(ctx: HttpContext): PulseDelivery {
    const { request } = ctx

    /**
     * The signature covers the raw bytes exactly as received. AdonisJS'
     * bodyparser keeps them for JSON requests, so no extra configuration is
     * needed — but re-serialising `request.body()` would produce different
     * bytes (Chariow escapes forward slashes and non-ASCII characters) and
     * every signature would fail.
     */
    const rawBody = request.raw()
    if (!rawBody) {
      throw new ChariowInvalidSignatureError('the request body was empty')
    }

    const received = request.header(SIGNATURE_HEADER)
    if (!received) {
      throw new ChariowInvalidSignatureError(`the ${SIGNATURE_HEADER} header is missing`)
    }

    if (!received.startsWith(SIGNATURE_PREFIX)) {
      throw new ChariowInvalidSignatureError(
        `unsupported signature scheme, expected a "${SIGNATURE_PREFIX}" prefix`
      )
    }

    const pulseId = request.header('x-pulse-id') ?? null
    const secret = this.#resolveSecret(pulseId)
    const expected = SIGNATURE_PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex')

    if (!safeEqual(received, expected)) {
      throw new ChariowInvalidSignatureError('the digest does not match')
    }

    let payload: AnyPulsePayload
    try {
      payload = JSON.parse(rawBody) as AnyPulsePayload
    } catch {
      throw new ChariowInvalidSignatureError('the body is not valid JSON')
    }

    /**
     * The event name is read from the signed body first. Headers are not
     * covered by the signature, so they are only trusted for the delivery id,
     * which merely drives de-duplication.
     */
    const event = (payload?.event ?? request.header('x-pulse-event')) as PulseEvent | undefined
    if (!event) {
      throw new ChariowInvalidSignatureError('the payload carries no event name')
    }

    const deliveryId = request.header('x-pulse-delivery-id') ?? null

    return {
      event,
      pulseId,
      deliveryId,
      payload,
      isTest: deliveryId === null,
    }
  }

  /**
   * Verifies the request, skips deliveries already handled, runs the matching
   * handler and answers 200.
   *
   * ```ts
   * await chariow.pulses.handle(ctx, {
   *   'successful.sale': async (payload) => grantAccess(payload.customer.email),
   * })
   * ```
   *
   * The handler is awaited, so a handler that throws produces a non-2xx and
   * Chariow retries the delivery. Push slow work onto a queue rather than
   * doing it inline.
   */
  async handle(ctx: HttpContext, handlers: PulseHandlers): Promise<PulseDelivery> {
    const delivery = this.verify(ctx)
    const store = this.#dedupe

    if (store && delivery.deliveryId) {
      if (await store.seen(delivery.deliveryId)) {
        ctx.response.ok({ received: true, duplicate: true })
        return delivery
      }
      await store.remember(delivery.deliveryId)
    }

    const handler = handlers[delivery.event] as Handler<PulseEvent> | undefined

    if (handler) {
      await handler(delivery.payload, delivery)
    } else if (handlers['*']) {
      await handlers['*'](delivery.event, delivery.payload, delivery)
    }

    ctx.response.ok({ received: true })
    return delivery
  }

  /**
   * A Pulse signs with its own secret, so an app receiving several Pulses on
   * one endpoint configures a record keyed by Pulse ID.
   */
  #resolveSecret(pulseId: string | null): string {
    const configured = this.#config.pulseSecret

    if (!configured) {
      throw new ChariowInvalidSignatureError(
        'no Pulse signing secret is configured. Set CHARIOW_PULSE_SECRET — it is the whsec_… value under Automations → Pulses → Overview, not your API key'
      )
    }

    if (typeof configured === 'string') {
      return configured
    }

    const secret = pulseId ? configured[pulseId] : undefined
    if (!secret) {
      throw new ChariowInvalidSignatureError(
        `no signing secret configured for Pulse "${pulseId ?? 'unknown'}"`
      )
    }

    return secret
  }
}

/**
 * Constant-time comparison. Lengths are checked first because
 * `timingSafeEqual` throws on buffers of different sizes, and a wrong-length
 * signature must be rejected, not raise.
 */
function safeEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)

  if (a.length !== b.length) {
    return false
  }

  return timingSafeEqual(a, b)
}
