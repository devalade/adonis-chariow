import { createHmac, timingSafeEqual } from 'node:crypto'
import { Result } from 'better-result'
import type { HttpContext } from '@adonisjs/core/http'

import type { Clock, PulseDedupeStore, ResolvedChariowConfig } from './define_config.ts'
import type { ChariowClient } from './client.ts'
import type { Redacted } from './redacted.ts'
import {
  PulsePayloadUnexpected,
  PulseSignatureInvalid,
  toShapeIssues,
  type ChariowApiFailure,
  type PulseFailure,
} from './failures.ts'
import {
  pageOf,
  PulseEnvelopeSchema,
  PulsePayloadSchemas,
  PulseSchema,
  type AnyPulsePayload,
  type Page,
  type Pulse,
  type PulseEvent,
  type PulseListParams,
  type PulsePayloads,
} from './schemas.ts'

/**
 * A verified Pulse delivery.
 *
 * @template E - The event this delivery carries.
 */
export type PulseDelivery<E extends PulseEvent = PulseEvent> = {
  readonly event: E
  /** From the `x-pulse-id` header. */
  readonly pulseId: string | null
  /** From the `x-pulse-delivery-id` header. Absent on dashboard test events. */
  readonly deliveryId: string | null
  readonly payload: PulsePayloads[E]
  /** True for a test event sent from the dashboard, which has no delivery record. */
  readonly isTest: boolean
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
  readonly #entries = new Map<string, number>()
  readonly #now: Clock

  constructor(now: Clock = Date.now) {
    this.#now = now
  }

  /** @returns Whether this delivery was already processed within the window. */
  seen(deliveryId: string): boolean {
    const expiresAt = this.#entries.get(deliveryId)

    if (expiresAt === undefined) {
      return false
    }

    if (expiresAt <= this.#now()) {
      this.#entries.delete(deliveryId)
      return false
    }

    return true
  }

  /** Records a delivery as processed. */
  remember(deliveryId: string): void {
    this.#prune()
    this.#entries.set(deliveryId, this.#now() + DEDUPE_TTL)
  }

  #prune(): void {
    const now = this.#now()

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
  readonly #client: ChariowClient
  readonly #config: ResolvedChariowConfig
  readonly #dedupe: PulseDedupeStore | false

  constructor(client: ChariowClient, config: ResolvedChariowConfig) {
    this.#client = client
    this.#config = config
    this.#dedupe =
      config.dedupe === false ? false : (config.dedupe ?? new MemoryDedupeStore(config.now))
  }

  /**
   * Lists the Pulses configured on the store.
   *
   * @returns One page of Pulses, or the failure that stopped the call.
   */
  list(params: PulseListParams = {}): Promise<Result<Page<Pulse>, ChariowApiFailure>> {
    return this.#client.get('/pulses', {
      operation: 'listPulses',
      schema: pageOf(PulseSchema),
      query: { ...params },
    })
  }

  /**
   * Retrieves one Pulse configuration.
   *
   * @returns The Pulse, or the failure that stopped the call.
   */
  get(pulseId: string): Promise<Result<Pulse, ChariowApiFailure>> {
    return this.#client.get(`/pulses/${encodeURIComponent(pulseId)}`, {
      operation: 'getPulse',
      schema: PulseSchema,
    })
  }

  /**
   * Verifies that a request genuinely came from Chariow and parses its
   * payload.
   *
   * Your endpoint URL is public, so anyone who finds it can post to it — never
   * act on a payload this has not accepted.
   *
   * @returns The delivery, or why it could not be trusted.
   */
  verify(ctx: HttpContext): Result<PulseDelivery, PulseFailure> {
    const { request } = ctx
    const pulseId = request.header('x-pulse-id') ?? null

    /**
     * The signature covers the raw bytes exactly as received. AdonisJS'
     * bodyparser keeps them for JSON requests, so no extra configuration is
     * needed — but re-serialising `request.body()` would produce different
     * bytes (Chariow escapes forward slashes and non-ASCII characters) and
     * every signature would fail.
     */
    const rawBody = request.raw()
    if (rawBody === null || rawBody === '') {
      return Result.err(this.#reject('the request body was empty', pulseId))
    }

    const received = request.header(SIGNATURE_HEADER)
    if (received === undefined) {
      return Result.err(this.#reject(`the ${SIGNATURE_HEADER} header is missing`, pulseId))
    }

    if (!received.startsWith(SIGNATURE_PREFIX)) {
      return Result.err(
        this.#reject(
          `unsupported signature scheme, expected a "${SIGNATURE_PREFIX}" prefix`,
          pulseId
        )
      )
    }

    const secret = this.#resolveSecret(pulseId)
    if (Result.isError(secret)) {
      return secret
    }

    const expected =
      SIGNATURE_PREFIX + createHmac('sha256', secret.value.reveal()).update(rawBody).digest('hex')

    if (!safeEqual(received, expected)) {
      return Result.err(this.#reject('the digest does not match', pulseId))
    }

    return this.#parsePayload(rawBody, pulseId, request.header('x-pulse-delivery-id') ?? null)
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
   *
   * @returns The delivery that was processed.
   * @throws {PulseSignatureInvalid} When the signature does not verify. This
   * is the AdonisJS-facing seam: the exception carries a 401 status, so the
   * framework's exception handler renders it. Call {@link verify} instead to
   * receive the failure as a value.
   * @throws {PulsePayloadUnexpected} When the body is not a Pulse payload.
   */
  async handle(ctx: HttpContext, handlers: PulseHandlers): Promise<PulseDelivery> {
    const verified = this.verify(ctx)
    if (Result.isError(verified)) {
      throw verified.error
    }

    const delivery = verified.value
    const store = this.#dedupe

    if (store !== false && delivery.deliveryId !== null) {
      if (await store.seen(delivery.deliveryId)) {
        ctx.response.ok({ received: true, duplicate: true })
        return delivery
      }
      await store.remember(delivery.deliveryId)
    }

    await runHandler(delivery, handlers)

    ctx.response.ok({ received: true })
    return delivery
  }

  /**
   * Parses the verified body. The event name is read from the signed body, not
   * from the unsigned `x-pulse-event` header, so a caller cannot be steered
   * into the wrong handler by editing a header.
   */
  #parsePayload(
    rawBody: string,
    pulseId: string | null,
    deliveryId: string | null
  ): Result<PulseDelivery, PulseFailure> {
    let decoded: unknown
    try {
      decoded = JSON.parse(rawBody)
    } catch {
      return Result.err(this.#reject('the body is not valid JSON', pulseId))
    }

    const envelope = PulseEnvelopeSchema.safeParse(decoded)
    if (!envelope.success) {
      return Result.err(
        new PulsePayloadUnexpected({
          pulseId,
          issues: toShapeIssues(envelope.error.issues),
          message: 'The Pulse payload carries no recognised event name',
        })
      )
    }

    const event = envelope.data.event
    const payload = PulsePayloadSchemas[event].safeParse(decoded)
    if (!payload.success) {
      return Result.err(
        new PulsePayloadUnexpected({
          pulseId,
          issues: toShapeIssues(payload.error.issues),
          message: `The ${event} payload did not match the documented shape`,
        })
      )
    }

    return Result.ok({
      event,
      pulseId,
      deliveryId,
      payload: payload.data,
      isTest: deliveryId === null,
    })
  }

  #reject(reason: string, pulseId: string | null): PulseSignatureInvalid {
    return new PulseSignatureInvalid({
      reason,
      pulseId,
      message: `Invalid Chariow Pulse signature: ${reason}`,
    })
  }

  /**
   * A Pulse signs with its own secret, so an app receiving several Pulses on
   * one endpoint configures a record keyed by Pulse ID.
   */
  #resolveSecret(pulseId: string | null): Result<Redacted<string>, PulseSignatureInvalid> {
    const configured = this.#config.pulseSecret

    if (configured === null) {
      return Result.err(
        this.#reject(
          'no Pulse signing secret is configured. Set CHARIOW_PULSE_SECRET — it is the whsec_… value under Automations → Pulses → Overview, not your API key',
          pulseId
        )
      )
    }

    if (!isSecretsByPulseId(configured)) {
      return Result.ok(configured)
    }

    const secret = pulseId === null ? undefined : configured[pulseId]
    if (secret === undefined) {
      return Result.err(
        this.#reject(`no signing secret configured for Pulse "${pulseId ?? 'unknown'}"`, pulseId)
      )
    }

    return Result.ok(secret)
  }
}

/**
 * Routes a delivery to its handler, falling back to `'*'`. An event with no
 * handler at all is a no-op, so subscribing to an extra event in the dashboard
 * does not break the endpoint.
 */
async function runHandler(delivery: PulseDelivery, handlers: PulseHandlers): Promise<void> {
  switch (delivery.event) {
    case 'successful.sale':
    case 'abandoned.sale':
    case 'failed.sale':
    case 'license.issued':
    case 'license.activated':
    case 'license.expired':
    case 'license.nearing_expiry':
    case 'license.revoked':
    case 'affiliate.joined': {
      const handler = handlers[delivery.event]
      if (handler !== undefined) {
        /**
         * SAFETY: `delivery.event` narrowed to this case, and `payload` was
         * parsed by that event's schema in #parsePayload, so handler and
         * payload agree. TypeScript cannot follow the correlation across the
         * two indexed lookups.
         */
        await (handler as Handler<typeof delivery.event>)(
          delivery.payload as PulsePayloads[typeof delivery.event],
          delivery as PulseDelivery<typeof delivery.event>
        )
        return
      }
      break
    }
  }

  const fallback = handlers['*']
  if (fallback !== undefined) {
    await fallback(delivery.event, delivery.payload, delivery)
  }
}

/** Distinguishes the per-Pulse secret map from a single wrapped secret. */
function isSecretsByPulseId(
  configured: NonNullable<ResolvedChariowConfig['pulseSecret']>
): configured is Readonly<Record<string, Redacted<string>>> {
  return !('reveal' in configured)
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
