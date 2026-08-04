import { Result } from 'better-result'
import type { HttpContext } from '@adonisjs/core/http'

import type { ChariowClient } from './client.ts'
import type { ResolvedChariowConfig } from './define_config.ts'
import { ChariowNotFound, type ChariowApiFailure } from './failures.ts'
import type { PulseDelivery, PulseHandlers } from './pulses.ts'
import {
  CustomerSchema,
  LicenseSchema,
  pageOf,
  type CheckoutPayload,
  type CheckoutResult,
  type License,
  type PulsePayloads,
} from './schemas.ts'
import { decideSubscription, type Subscription } from './subscription.ts'

/**
 * The buyer details a licence does not carry, needed to start a renewal
 * checkout. The product and the email come from the subscription itself.
 */
export type RenewalBuyer = {
  readonly first_name: string
  readonly last_name: string
  readonly phone: { readonly number: string; readonly country_code: string }
  readonly discount_code?: string
  /** Overrides the email taken from the subscription's licence. */
  readonly email?: string
}

/** Narrows a lookup to one product. Omit it to consider every product. */
export type SubscriptionLookup = {
  readonly product_id?: string
}

/**
 * Subscription lifecycle handlers, in business language rather than Pulse
 * event names. Each receives the standing derived from the delivered licence,
 * so `daysRemaining` and `expiresAt` are available without another API call.
 */
export type SubscriptionHandlers = {
  /** A licence was issued: a subscription began, or an existing one was renewed. */
  onStarted?: (
    subscription: Subscription,
    payload: PulsePayloads['license.issued']
  ) => unknown | Promise<unknown>
  /** The customer activated their licence on a device. */
  onActivated?: (
    subscription: Subscription,
    payload: PulsePayloads['license.activated']
  ) => unknown | Promise<unknown>
  /** Expiry is approaching. Access still works — prompt for renewal. */
  onRenewalDue?: (
    subscription: Subscription,
    payload: PulsePayloads['license.nearing_expiry']
  ) => unknown | Promise<unknown>
  /** The subscription expired. Access should stop. */
  onLapsed?: (
    subscription: Subscription,
    payload: PulsePayloads['license.expired']
  ) => unknown | Promise<unknown>
  /** The subscription was revoked. Access should stop and not be renewable. */
  onCancelled?: (
    subscription: Subscription,
    payload: PulsePayloads['license.revoked']
  ) => unknown | Promise<unknown>
}

/**
 * What this resource needs from the rest of the package, named narrowly so it
 * does not depend on the whole facade.
 */
export type SubscriptionsDependencies = {
  readonly createCheckout: (payload: CheckoutPayload, ctx?: HttpContext) => Promise<CheckoutResult>
  readonly handlePulse: (ctx: HttpContext, handlers: PulseHandlers) => Promise<PulseDelivery>
}

type CacheEntry = { readonly licenses: ReadonlyArray<License>; readonly expiresAt: number }

/**
 * A customer with more licences for one product than this has never been seen
 * in practice; the cap only stops an unbounded walk if the API misbehaves.
 */
const MAX_PAGES = 10
const PER_PAGE = 100

/**
 * Recurring access built on Chariow licences.
 *
 * Chariow has no subscription resource: renewing means buying again, which
 * issues a new licence rather than extending the old one. This reads the
 * licences a customer holds and answers the two questions an app has — may
 * they in, and do they need to pay again.
 */
export class SubscriptionsResource {
  readonly #client: ChariowClient
  readonly #config: ResolvedChariowConfig
  readonly #deps: SubscriptionsDependencies
  readonly #cache = new Map<string, CacheEntry>()
  readonly #customerIdByEmail = new Map<string, { id: string | null; expiresAt: number }>()

  constructor(
    client: ChariowClient,
    config: ResolvedChariowConfig,
    deps: SubscriptionsDependencies
  ) {
    this.#client = client
    this.#config = config
    this.#deps = deps
  }

  /**
   * The standing of a Chariow customer. One request, so this is the path to
   * prefer — store the `customer_id` you receive in the sale Pulse against
   * your user and use it here.
   *
   * ```ts
   * const sub = await chariow.subscriptions.forCustomer(user.chariowCustomerId, {
   *   product_id: 'prd_pro',
   * })
   *
   * if (!sub.isActive) return response.forbidden({ status: sub.status })
   * ```
   *
   * @throws {Error} A {@link ChariowApiFailure} when the lookup fails. An
   * outage must not read as "not subscribed".
   */
  async forCustomer(customerId: string, lookup: SubscriptionLookup = {}): Promise<Subscription> {
    const licenses = await this.#licensesFor(customerId, lookup.product_id)
    return this.#decide(licenses)
  }

  /**
   * The standing of whoever holds this email address. Two requests: the email
   * is resolved to a Chariow customer first.
   *
   * @throws {Error} A {@link ChariowApiFailure} when the lookup fails.
   */
  async forEmail(email: string, lookup: SubscriptionLookup = {}): Promise<Subscription> {
    const customerId = await this.#customerIdFor(email)

    if (customerId === null) {
      return this.#decide([])
    }

    return this.forCustomer(customerId, lookup)
  }

  /**
   * The standing of one licence key, for apps that store the key itself rather
   * than the customer.
   *
   * An unknown key reports `none` rather than failing — a customer mistyping
   * their key is a normal path.
   *
   * @throws {Error} A {@link ChariowApiFailure} for failures other than an
   * unknown key.
   */
  async forLicense(licenseKey: string): Promise<Subscription> {
    const found = await this.#client.get(`/licenses/${encodeURIComponent(licenseKey)}`, {
      operation: 'getLicense',
      schema: LicenseSchema,
    })

    if (Result.isError(found)) {
      if (found.error instanceof ChariowNotFound) {
        return this.#decide([])
      }
      throw found.error
    }

    return this.#decide([found.value])
  }

  /**
   * Starts a checkout to renew a subscription, and returns where to send the
   * customer to pay.
   *
   * Chariow has no stored-payment or recurring-charge API, so renewal is
   * always the customer buying again. The product and the email come from the
   * subscription's licence; `buyer` supplies what a licence does not carry.
   * The customer's full name is deliberately not split into first and last —
   * that guess is wrong too often to make quietly.
   *
   * ```ts
   * const result = await chariow.subscriptions.renew(sub, {
   *   first_name: user.firstName,
   *   last_name: user.lastName,
   *   phone: { number: user.phone, country_code: '+229' },
   * }, ctx)
   * ```
   *
   * @throws {Error} When the subscription has no licence to renew, which is a
   * defect in the calling code, or a {@link ChariowApiFailure} when checkout
   * fails.
   */
  renew(
    subscription: Subscription,
    buyer: RenewalBuyer,
    ctx?: HttpContext
  ): Promise<CheckoutResult> {
    const license = subscription.license

    if (license === null || license.product === undefined) {
      throw new Error(
        'Cannot renew a subscription with no licence. Check `subscription.status` before renewing.'
      )
    }

    const email = buyer.email ?? license.customer?.email

    if (email === undefined) {
      throw new Error(
        'Cannot renew: the licence carries no customer email. Pass `email` on the buyer.'
      )
    }

    this.#forget(license)

    return this.#deps.createCheckout(
      {
        product_id: license.product.id,
        email,
        first_name: buyer.first_name,
        last_name: buyer.last_name,
        phone: buyer.phone,
        ...(buyer.discount_code === undefined ? {} : { discount_code: buyer.discount_code }),
      },
      ctx
    )
  }

  /**
   * Receives Pulse deliveries as subscription lifecycle events.
   *
   * ```ts
   * await chariow.subscriptions.handle(ctx, {
   *   onRenewalDue: async (sub) => mail.send(new RenewalReminder(sub.daysRemaining)),
   *   onLapsed: async (sub) => access.revoke(sub.license.customer.email),
   * })
   * ```
   *
   * The delivered payload already carries the whole licence, so the standing
   * is derived from it without a second API call. Signature verification,
   * payload parsing and delivery de-duplication come from
   * {@link PulsesResource.handle}, so sale events reaching the same endpoint
   * are answered normally and ignored here.
   *
   * @returns The delivery that was processed.
   * @throws {Error} The same failures as `pulses.handle`.
   */
  handle(ctx: HttpContext, handlers: SubscriptionHandlers): Promise<PulseDelivery> {
    return this.#deps.handlePulse(ctx, {
      'license.issued': async (payload) => {
        this.#forget(payload.license)
        await handlers.onStarted?.(this.#decide([payload.license]), payload)
      },
      'license.activated': async (payload) => {
        this.#forget(payload.license)
        await handlers.onActivated?.(this.#decide([payload.license]), payload)
      },
      'license.nearing_expiry': async (payload) => {
        await handlers.onRenewalDue?.(this.#decide([payload.license]), payload)
      },
      'license.expired': async (payload) => {
        this.#forget(payload.license)
        await handlers.onLapsed?.(this.#decide([payload.license]), payload)
      },
      'license.revoked': async (payload) => {
        this.#forget(payload.license)
        await handlers.onCancelled?.(this.#decide([payload.license]), payload)
      },
    })
  }

  /*
  |--------------------------------------------------------------------------
  | Internals
  |--------------------------------------------------------------------------
  */

  /**
   * Derives the standing now. Licences are cached, the decision is not, so
   * `daysRemaining` stays honest as time passes within a cache window.
   */
  #decide(licenses: ReadonlyArray<License>): Subscription {
    return decideSubscription(licenses, this.#config.now(), {
      renewalWindowDays: this.#config.renewalWindowDays,
    })
  }

  /** Every licence a customer holds, for one product or for all of them. */
  async #licensesFor(
    customerId: string,
    productId: string | undefined
  ): Promise<ReadonlyArray<License>> {
    const key = `${customerId}|${productId ?? '*'}`
    const cached = this.#cached(key)

    if (cached !== null) {
      return cached
    }

    const collected: License[] = []
    let cursor: string | undefined
    let page = 0

    while (page < MAX_PAGES) {
      page++

      const result = await this.#client.get('/licenses', {
        operation: 'listLicenses',
        schema: pageOf(LicenseSchema),
        query: { customer_id: customerId, product_id: productId, per_page: PER_PAGE, cursor },
      })

      if (Result.isError(result)) {
        throw result.error
      }

      collected.push(...result.value.data)

      const next = result.value.pagination.next_cursor
      if (!result.value.pagination.has_more || next === null || next === cursor) {
        break
      }

      cursor = next
    }

    this.#remember(key, collected)
    return collected
  }

  /**
   * Resolves an email to a Chariow customer.
   *
   * The customers search matches name *or* email, so a hit is only accepted
   * when the email matches exactly. Guessing from a partial match would hand
   * one customer another's subscription.
   */
  async #customerIdFor(email: string): Promise<string | null> {
    const normalised = email.trim().toLowerCase()
    const cached = this.#customerIdByEmail.get(normalised)

    if (cached !== undefined && cached.expiresAt > this.#config.now()) {
      return cached.id
    }

    const result = await this.#client.get('/customers', {
      operation: 'listCustomers',
      schema: pageOf(CustomerSchema),
      query: { search: normalised, per_page: PER_PAGE },
    })

    if (Result.isError(result)) {
      throw result.error
    }

    const match = result.value.data.find(
      (customer) => customer.email.trim().toLowerCase() === normalised
    )

    const id = match?.id ?? null

    if (this.#config.subscriptionCacheTtl > 0) {
      this.#customerIdByEmail.set(normalised, {
        id,
        expiresAt: this.#config.now() + this.#config.subscriptionCacheTtl,
      })
    }

    return id
  }

  #cached(key: string): ReadonlyArray<License> | null {
    if (this.#config.subscriptionCacheTtl <= 0) {
      return null
    }

    const entry = this.#cache.get(key)
    if (entry === undefined) {
      return null
    }

    if (entry.expiresAt <= this.#config.now()) {
      this.#cache.delete(key)
      return null
    }

    return entry.licenses
  }

  #remember(key: string, licenses: ReadonlyArray<License>): void {
    if (this.#config.subscriptionCacheTtl <= 0) {
      return
    }

    this.#cache.set(key, {
      licenses,
      expiresAt: this.#config.now() + this.#config.subscriptionCacheTtl,
    })
  }

  /**
   * Drops any cached standing this licence contributes to, so a lifecycle
   * event or a renewal is reflected on the next lookup instead of after the
   * TTL.
   */
  #forget(license: License): void {
    const customerId = license.customer?.id
    if (customerId === undefined) {
      return
    }

    this.#cache.delete(`${customerId}|*`)

    const productId = license.product?.id
    if (productId !== undefined) {
      this.#cache.delete(`${customerId}|${productId}`)
    }
  }
}
