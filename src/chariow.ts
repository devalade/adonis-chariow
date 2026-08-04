import { Result } from 'better-result'
import type { HttpContext } from '@adonisjs/core/http'
import { z } from 'zod'

import { ChariowClient, type QueryParams } from './client.ts'
import {
  resolveConfig,
  type ChariowConfig,
  type ResolvedChariowConfig,
} from './define_config.ts'
import { ChariowNotFound, type ChariowApiFailure } from './failures.ts'
import { decideLicenseAccess, LICENSE_NOT_FOUND, type LicenseCheck } from './license_access.ts'
import { PulsesResource } from './pulses.ts'
import { SubscriptionsResource } from './subscriptions_resource.ts'
import {
  ActivationSchema,
  AffiliateInvitationSchema,
  AffiliateSchema,
  CheckoutPayloadSchema,
  CheckoutResultSchema,
  CustomerSchema,
  DiscountSchema,
  LicenseSchema,
  pageOf,
  ProductSchema,
  SaleDetailSchema,
  SaleSummarySchema,
  StoreSchema,
  type Activation,
  type Affiliate,
  type AffiliateInvitation,
  type CheckoutPayload,
  type CheckoutResult,
  type Customer,
  type CustomerListParams,
  type Discount,
  type DiscountListParams,
  type License,
  type LicenseListParams,
  type ListParams,
  type Page,
  type Product,
  type ProductListParams,
  type SaleDetail,
  type SaleListParams,
  type SaleSummary,
  type Store,
} from './schemas.ts'

type CacheEntry = { readonly license: License; readonly expiresAt: number }

/**
 * Unwraps a result at the AdonisJS-facing seam, throwing the failure so the
 * framework's exception handler renders it with the right status.
 *
 * @template T - The success value.
 */
function orThrow<T>(result: Result<T, ChariowApiFailure>): T {
  if (Result.isError(result)) {
    throw result.error
  }

  return result.value
}

/**
 * The Chariow API, wired for AdonisJS.
 *
 * Every method throws its expected failure rather than returning it, because
 * that is what AdonisJS controllers expect: the failures carry `status` and
 * `code`, so the framework's exception handler turns them into the right HTTP
 * response. {@link Chariow.client} exposes the same calls as typed results for
 * callers who would rather branch than catch.
 *
 * ```ts
 * import chariow from '@devalade/adonis-chariow/services/main'
 *
 * const result = await chariow.checkout.create(payload, ctx)
 * const check = await chariow.licenses.check(key)
 * ```
 */
export class Chariow {
  readonly #client: ChariowClient
  readonly #config: ResolvedChariowConfig
  readonly #licenseCache = new Map<string, CacheEntry>()

  /**
   * The underlying HTTP adapter. Its methods return typed results instead of
   * throwing, and it reaches endpoints this facade does not wrap yet.
   */
  get client(): ChariowClient {
    return this.#client
  }

  constructor(config: ChariowConfig) {
    this.#config = resolveConfig(config)
    this.#client = new ChariowClient(this.#config)
    this.pulses = new PulsesResource(this.#client, this.#config)
    this.subscriptions = new SubscriptionsResource(this.#client, this.#config, {
      createCheckout: (payload, ctx) => this.checkout.create(payload, ctx),
      handlePulse: (ctx, handlers) => this.pulses.handle(ctx, handlers),
    })
  }

  /*
  |--------------------------------------------------------------------------
  | Store
  |--------------------------------------------------------------------------
  */

  /** The store this API key belongs to. */
  readonly store = {
    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    get: async (): Promise<Store> =>
      orThrow(await this.#client.get('/store', { operation: 'getStore', schema: StoreSchema })),
  }

  /*
  |--------------------------------------------------------------------------
  | Products
  |--------------------------------------------------------------------------
  */

  /** Published products. */
  readonly products = {
    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    list: async (params: ProductListParams = {}): Promise<Page<Product>> =>
      orThrow(
        await this.#client.get('/products', {
          operation: 'listProducts',
          schema: pageOf(ProductSchema),
          query: { ...params },
        })
      ),

    /**
     * Accepts a product public ID or its slug.
     *
     * @throws {Error} A {@link ChariowApiFailure} when the call fails.
     */
    get: async (idOrSlug: string): Promise<Product> =>
      orThrow(
        await this.#client.get(`/products/${encodeURIComponent(idOrSlug)}`, {
          operation: 'getProduct',
          schema: ProductSchema,
        })
      ),

    /** Walks every page. @throws {Error} A {@link ChariowApiFailure} when a page fails. */
    all: (params: ProductListParams = {}): AsyncIterable<Product> =>
      this.#paginate('/products', 'listProducts', ProductSchema, params),
  }

  /*
  |--------------------------------------------------------------------------
  | Checkout
  |--------------------------------------------------------------------------
  */

  /** Starting a paid checkout. */
  readonly checkout = {
    /**
     * Starts a checkout and returns the payment URL to redirect the buyer to.
     *
     * Pass the HttpContext so the buyer's IP is forwarded: this endpoint is
     * called server to server, so without it Chariow records your server's IP
     * and resolves the buyer's country wrongly.
     *
     * ```ts
     * const result = await chariow.checkout.create({
     *   product_id: 'prd_abc',
     *   email: 'buyer@example.com',
     *   first_name: 'Ada',
     *   last_name: 'Lovelace',
     *   phone: { number: '97000000', country_code: '+229' },
     * }, ctx)
     *
     * return response.redirect(result.payment.checkout_url)
     * ```
     *
     * @throws {Error} A {@link ChariowApiFailure} when the call fails, or a
     * `ZodError` when the payload is malformed — a defect in your own code,
     * caught here rather than as a 422 round trip.
     */
    create: async (payload: CheckoutPayload, ctx?: HttpContext): Promise<CheckoutResult> => {
      const body = CheckoutPayloadSchema.parse(payload)

      if (ctx !== undefined && body.customer_ip === undefined) {
        body.customer_ip = ctx.request.ip()
      }

      if (this.#config.currency !== null && body.payment_currency === undefined) {
        body.payment_currency = this.#config.currency
      }

      return orThrow(
        await this.#client.post('/checkout', {
          operation: 'initCheckout',
          schema: CheckoutResultSchema,
          body,
          /** Never retried: a retried checkout is a duplicate sale. */
          retry: false,
        })
      )
    },
  }

  /*
  |--------------------------------------------------------------------------
  | Sales
  |--------------------------------------------------------------------------
  */

  /** Completed, failed and abandoned sales. */
  readonly sales = {
    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    list: async (params: SaleListParams = {}): Promise<Page<SaleSummary>> =>
      orThrow(
        await this.#client.get('/sales', {
          operation: 'listSales',
          schema: pageOf(SaleSummarySchema),
          query: { ...params },
        })
      ),

    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    get: async (saleId: string): Promise<SaleDetail> =>
      orThrow(
        await this.#client.get(`/sales/${encodeURIComponent(saleId)}`, {
          operation: 'getSale',
          schema: SaleDetailSchema,
        })
      ),

    /** Walks every page. @throws {Error} A {@link ChariowApiFailure} when a page fails. */
    all: (params: SaleListParams = {}): AsyncIterable<SaleSummary> =>
      this.#paginate('/sales', 'listSales', SaleSummarySchema, params),
  }

  /*
  |--------------------------------------------------------------------------
  | Customers
  |--------------------------------------------------------------------------
  */

  /** People who bought from the store. */
  readonly customers = {
    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    list: async (params: CustomerListParams = {}): Promise<Page<Customer>> =>
      orThrow(
        await this.#client.get('/customers', {
          operation: 'listCustomers',
          schema: pageOf(CustomerSchema),
          query: { ...params },
        })
      ),

    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    get: async (customerId: string): Promise<Customer> =>
      orThrow(
        await this.#client.get(`/customers/${encodeURIComponent(customerId)}`, {
          operation: 'getCustomer',
          schema: CustomerSchema,
        })
      ),

    /** Walks every page. @throws {Error} A {@link ChariowApiFailure} when a page fails. */
    all: (params: CustomerListParams = {}): AsyncIterable<Customer> =>
      this.#paginate('/customers', 'listCustomers', CustomerSchema, params),
  }

  /*
  |--------------------------------------------------------------------------
  | Licenses
  |--------------------------------------------------------------------------
  */

  /** License keys, and the paywall decision built on them. */
  readonly licenses = {
    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    list: async (params: LicenseListParams = {}): Promise<Page<License>> =>
      orThrow(
        await this.#client.get('/licenses', {
          operation: 'listLicenses',
          schema: pageOf(LicenseSchema),
          query: { ...params },
        })
      ),

    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    get: async (licenseKey: string): Promise<License> =>
      orThrow(await this.#fetchLicense(licenseKey)),

    /** Walks every page. @throws {Error} A {@link ChariowApiFailure} when a page fails. */
    all: (params: LicenseListParams = {}): AsyncIterable<License> =>
      this.#paginate('/licenses', 'listLicenses', LicenseSchema, params),

    /**
     * Answers "may this key use my app?".
     *
     * A key Chariow does not know resolves to `{ valid: false, reason:
     * 'not_found' }` rather than throwing — a customer mistyping their key is
     * a normal path, not an exception.
     *
     * ```ts
     * const check = await chariow.licenses.check(key)
     * if (!check.valid) return response.forbidden({ reason: check.reason })
     * ```
     *
     * Successful lookups are cached for `config.licenseCacheTtl` ms, because
     * the API allows only 100 requests per minute.
     *
     * @throws {Error} A {@link ChariowApiFailure} for failures other than an
     * unknown key — a rate limit or an outage must not read as "no licence".
     */
    check: async (licenseKey: string): Promise<LicenseCheck> => {
      const cached = this.#cachedLicense(licenseKey)
      if (cached !== null) {
        return decideLicenseAccess(cached)
      }

      const fetched = await this.#fetchLicense(licenseKey)
      if (Result.isError(fetched)) {
        if (fetched.error instanceof ChariowNotFound) {
          return LICENSE_NOT_FOUND
        }
        throw fetched.error
      }

      return decideLicenseAccess(fetched.value)
    },

    /**
     * Activates the license on a device. `deviceIdentifier` is any stable
     * string identifying the installation.
     *
     * @throws {Error} A {@link ChariowApiFailure} when the call fails.
     */
    activate: async (licenseKey: string, deviceIdentifier?: string): Promise<License> => {
      const license = orThrow(
        await this.#client.post(`/licenses/${encodeURIComponent(licenseKey)}/activate`, {
          operation: 'activateLicense',
          schema: LicenseSchema,
          body: deviceIdentifier === undefined ? {} : { device_identifier: deviceIdentifier },
        })
      )

      this.#cacheLicense(licenseKey, license)
      return license
    },

    /**
     * Permanently revokes the license. This cannot be undone.
     *
     * @throws {Error} A {@link ChariowApiFailure} when the call fails.
     */
    revoke: async (licenseKey: string): Promise<License> => {
      const license = orThrow(
        await this.#client.post(`/licenses/${encodeURIComponent(licenseKey)}/revoke`, {
          operation: 'revokeLicense',
          schema: LicenseSchema,
        })
      )

      this.#cacheLicense(licenseKey, license)
      return license
    },

    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    activations: async (
      licenseKey: string,
      params: ListParams = {}
    ): Promise<Page<Activation>> =>
      orThrow(
        await this.#client.get(`/licenses/${encodeURIComponent(licenseKey)}/activations`, {
          operation: 'getLicenseActivations',
          schema: pageOf(ActivationSchema),
          query: { ...params },
        })
      ),
  }

  /*
  |--------------------------------------------------------------------------
  | Discounts
  |--------------------------------------------------------------------------
  */

  /** Discount codes. */
  readonly discounts = {
    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    list: async (params: DiscountListParams = {}): Promise<Page<Discount>> =>
      orThrow(
        await this.#client.get('/discounts', {
          operation: 'listDiscounts',
          schema: pageOf(DiscountSchema),
          query: { ...params },
        })
      ),

    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    get: async (discountId: string): Promise<Discount> =>
      orThrow(
        await this.#client.get(`/discounts/${encodeURIComponent(discountId)}`, {
          operation: 'getDiscount',
          schema: DiscountSchema,
        })
      ),

    /** Walks every page. @throws {Error} A {@link ChariowApiFailure} when a page fails. */
    all: (params: DiscountListParams = {}): AsyncIterable<Discount> =>
      this.#paginate('/discounts', 'listDiscounts', DiscountSchema, params),
  }

  /*
  |--------------------------------------------------------------------------
  | Affiliates
  |--------------------------------------------------------------------------
  */

  /** The affiliate programme. */
  readonly affiliates = {
    /** @throws {Error} A {@link ChariowApiFailure} when the call fails. */
    get: async (affiliateCode: string): Promise<Affiliate> =>
      orThrow(
        await this.#client.get(`/affiliates/${encodeURIComponent(affiliateCode)}`, {
          operation: 'getAffiliate',
          schema: AffiliateSchema,
        })
      ),

    /**
     * Invites up to 25 people to the affiliate programme.
     *
     * @throws {Error} A {@link ChariowApiFailure} when the call fails.
     */
    invite: async (emails: ReadonlyArray<string>): Promise<ReadonlyArray<AffiliateInvitation>> =>
      orThrow(
        await this.#client.post('/affiliates/invitations', {
          operation: 'sendAffiliateInvitations',
          schema: z.array(AffiliateInvitationSchema),
          body: { emails },
        })
      ),
  }

  /*
  |--------------------------------------------------------------------------
  | Pulses (webhooks)
  |--------------------------------------------------------------------------
  */

  /** Receiving signed webhook deliveries, and reading Pulse configurations. */
  readonly pulses: PulsesResource

  /*
  |--------------------------------------------------------------------------
  | Subscriptions
  |--------------------------------------------------------------------------
  */

  /**
   * Recurring access derived from licences. Chariow has no subscription
   * resource, so this computes the standing rather than fetching it.
   */
  readonly subscriptions: SubscriptionsResource

  /*
  |--------------------------------------------------------------------------
  | Internals
  |--------------------------------------------------------------------------
  */

  /**
   * Walks every page of a cursor-paginated endpoint.
   *
   * @template S - The schema for a single item.
   */
  async *#paginate<S extends z.ZodType>(
    path: string,
    operation: string,
    item: S,
    params: ListParams & QueryParams
  ): AsyncGenerator<z.infer<S>> {
    const schema = pageOf(item)
    let cursor: string | undefined = params.cursor
    const seenCursors = new Set<string>()

    while (true) {
      const page = orThrow(
        await this.#client.get(path, { operation, schema, query: { ...params, cursor } })
      )

      for (const value of page.data) {
        yield value
      }

      const next = page.pagination.next_cursor

      /**
       * Stop on a repeated cursor rather than looping forever if the API ever
       * hands back the same page.
       */
      if (!page.pagination.has_more || next === null || seenCursors.has(next)) {
        return
      }

      seenCursors.add(next)
      cursor = next
    }
  }

  #fetchLicense(licenseKey: string): Promise<Result<License, ChariowApiFailure>> {
    return this.#client
      .get(`/licenses/${encodeURIComponent(licenseKey)}`, {
        operation: 'getLicense',
        schema: LicenseSchema,
      })
      .then((result) => {
        if (Result.isOk(result)) {
          this.#cacheLicense(licenseKey, result.value)
        }
        return result
      })
  }

  #cachedLicense(licenseKey: string): License | null {
    if (this.#config.licenseCacheTtl <= 0) {
      return null
    }

    const entry = this.#licenseCache.get(licenseKey)
    if (entry === undefined) {
      return null
    }

    if (entry.expiresAt <= this.#config.now()) {
      this.#licenseCache.delete(licenseKey)
      return null
    }

    return entry.license
  }

  #cacheLicense(licenseKey: string, license: License): void {
    if (this.#config.licenseCacheTtl <= 0) {
      return
    }

    this.#licenseCache.set(licenseKey, {
      license,
      expiresAt: this.#config.now() + this.#config.licenseCacheTtl,
    })
  }
}
