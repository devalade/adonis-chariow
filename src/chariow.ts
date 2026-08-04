import type { HttpContext } from '@adonisjs/core/http'

import { ChariowClient, type QueryParams } from './client.ts'
import { resolveConfig, type ChariowConfig, type ResolvedChariowConfig } from './define_config.ts'
import { ChariowNotFoundError } from './errors.ts'
import { PulsesResource } from './pulses.ts'
import type {
  Activation,
  Affiliate,
  AffiliateInvitation,
  CheckoutPayload,
  CheckoutResult,
  Customer,
  CustomerListParams,
  Discount,
  DiscountListParams,
  License,
  LicenseCheck,
  LicenseListParams,
  ListParams,
  Page,
  Product,
  ProductListParams,
  SaleDetail,
  SaleListParams,
  SaleSummary,
  Store,
} from './types.ts'

type CacheEntry = { license: License; expiresAt: number }

/**
 * The Chariow API, wired for AdonisJS.
 *
 * ```ts
 * import chariow from '@devalade/adonis-chariow/services/main'
 *
 * const result = await chariow.checkout.create(payload, ctx)
 * const check = await chariow.licenses.check(key)
 * ```
 */
export class Chariow {
  #client: ChariowClient
  #config: ResolvedChariowConfig
  #licenseCache = new Map<string, CacheEntry>()

  /**
   * Direct access to the HTTP layer, for endpoints this package does not
   * wrap yet.
   */
  get client(): ChariowClient {
    return this.#client
  }

  constructor(config: ChariowConfig) {
    this.#config = resolveConfig(config)
    this.#client = new ChariowClient(this.#config)
    this.pulses = new PulsesResource(this.#client, this.#config)
  }

  /*
  |--------------------------------------------------------------------------
  | Store
  |--------------------------------------------------------------------------
  */

  store = {
    get: (): Promise<Store> => this.#client.get<Store>('/store'),
  }

  /*
  |--------------------------------------------------------------------------
  | Products
  |--------------------------------------------------------------------------
  */

  products = {
    list: (params: ProductListParams = {}): Promise<Page<Product>> =>
      this.#client.get<Page<Product>>('/products', { ...params }),

    /**
     * Accepts a product public ID or its slug.
     */
    get: (idOrSlug: string): Promise<Product> =>
      this.#client.get<Product>(`/products/${encodeURIComponent(idOrSlug)}`),

    all: (params: ProductListParams = {}): AsyncIterable<Product> =>
      this.#paginate<Product>('/products', params),
  }

  /*
  |--------------------------------------------------------------------------
  | Checkout
  |--------------------------------------------------------------------------
  */

  checkout = {
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
     * return response.redirect(result.payment.checkout_url!)
     * ```
     */
    create: (payload: CheckoutPayload, ctx?: HttpContext): Promise<CheckoutResult> => {
      const body: CheckoutPayload = { ...payload }

      if (ctx && !body.customer_ip) {
        body.customer_ip = ctx.request.ip()
      }

      if (this.#config.currency && !body.payment_currency) {
        body.payment_currency = this.#config.currency
      }

      /**
       * Never retried: a retried checkout is a duplicate sale.
       */
      return this.#client.post<CheckoutResult>('/checkout', body, { retry: false })
    },
  }

  /*
  |--------------------------------------------------------------------------
  | Sales
  |--------------------------------------------------------------------------
  */

  sales = {
    list: (params: SaleListParams = {}): Promise<Page<SaleSummary>> =>
      this.#client.get<Page<SaleSummary>>('/sales', { ...params }),

    get: (saleId: string): Promise<SaleDetail> =>
      this.#client.get<SaleDetail>(`/sales/${encodeURIComponent(saleId)}`),

    all: (params: SaleListParams = {}): AsyncIterable<SaleSummary> =>
      this.#paginate<SaleSummary>('/sales', params),
  }

  /*
  |--------------------------------------------------------------------------
  | Customers
  |--------------------------------------------------------------------------
  */

  customers = {
    list: (params: CustomerListParams = {}): Promise<Page<Customer>> =>
      this.#client.get<Page<Customer>>('/customers', { ...params }),

    get: (customerId: string): Promise<Customer> =>
      this.#client.get<Customer>(`/customers/${encodeURIComponent(customerId)}`),

    all: (params: CustomerListParams = {}): AsyncIterable<Customer> =>
      this.#paginate<Customer>('/customers', params),
  }

  /*
  |--------------------------------------------------------------------------
  | Licenses
  |--------------------------------------------------------------------------
  */

  licenses = {
    list: (params: LicenseListParams = {}): Promise<Page<License>> =>
      this.#client.get<Page<License>>('/licenses', { ...params }),

    get: (licenseKey: string): Promise<License> =>
      this.#client.get<License>(`/licenses/${encodeURIComponent(licenseKey)}`),

    all: (params: LicenseListParams = {}): AsyncIterable<License> =>
      this.#paginate<License>('/licenses', params),

    /**
     * Answers "may this key use my app?" without throwing for a key that does
     * not exist — a customer mistyping their key is a normal path.
     *
     * ```ts
     * const check = await chariow.licenses.check(key)
     * if (!check.valid) return response.forbidden(check.reason)
     * ```
     *
     * Successful lookups are cached for `config.licenseCacheTtl` ms, because
     * the API allows only 100 requests per minute.
     */
    check: async (licenseKey: string): Promise<LicenseCheck> => {
      let license = this.#cachedLicense(licenseKey)

      if (!license) {
        try {
          license = await this.licenses.get(licenseKey)
          this.#cacheLicense(licenseKey, license)
        } catch (error) {
          if (error instanceof ChariowNotFoundError) {
            return { valid: false, license: null, reason: 'not_found' }
          }
          throw error
        }
      }

      if (license.status === 'revoked') {
        return { valid: false, license, reason: 'revoked' }
      }

      if (license.is_expired || license.status === 'expired') {
        return { valid: false, license, reason: 'expired' }
      }

      /**
       * Covers `pending_activation` too: a license nobody has activated yet
       * does not grant access.
       */
      if (license.is_active !== true) {
        return { valid: false, license, reason: 'inactive' }
      }

      return { valid: true, license }
    },

    /**
     * Activates the license on a device. `deviceIdentifier` is any stable
     * string identifying the installation.
     */
    activate: async (licenseKey: string, deviceIdentifier?: string): Promise<License> => {
      const license = await this.#client.post<License>(
        `/licenses/${encodeURIComponent(licenseKey)}/activate`,
        deviceIdentifier ? { device_identifier: deviceIdentifier } : {}
      )

      this.#cacheLicense(licenseKey, license)
      return license
    },

    /**
     * Permanently revokes the license. This cannot be undone.
     */
    revoke: async (licenseKey: string): Promise<License> => {
      const license = await this.#client.post<License>(
        `/licenses/${encodeURIComponent(licenseKey)}/revoke`
      )

      this.#cacheLicense(licenseKey, license)
      return license
    },

    activations: (licenseKey: string, params: ListParams = {}): Promise<Page<Activation>> =>
      this.#client.get<Page<Activation>>(
        `/licenses/${encodeURIComponent(licenseKey)}/activations`,
        { ...params }
      ),
  }

  /*
  |--------------------------------------------------------------------------
  | Discounts
  |--------------------------------------------------------------------------
  */

  discounts = {
    list: (params: DiscountListParams = {}): Promise<Page<Discount>> =>
      this.#client.get<Page<Discount>>('/discounts', { ...params }),

    get: (discountId: string): Promise<Discount> =>
      this.#client.get<Discount>(`/discounts/${encodeURIComponent(discountId)}`),

    all: (params: DiscountListParams = {}): AsyncIterable<Discount> =>
      this.#paginate<Discount>('/discounts', params),
  }

  /*
  |--------------------------------------------------------------------------
  | Affiliates
  |--------------------------------------------------------------------------
  */

  affiliates = {
    get: (affiliateCode: string): Promise<Affiliate> =>
      this.#client.get<Affiliate>(`/affiliates/${encodeURIComponent(affiliateCode)}`),

    /**
     * Invites up to 25 people to the affiliate programme.
     */
    invite: (emails: string[]): Promise<AffiliateInvitation[]> =>
      this.#client.post<AffiliateInvitation[]>('/affiliates/invitations', { emails }),
  }

  /*
  |--------------------------------------------------------------------------
  | Pulses (webhooks)
  |--------------------------------------------------------------------------
  */

  pulses: PulsesResource

  /*
  |--------------------------------------------------------------------------
  | Internals
  |--------------------------------------------------------------------------
  */

  /**
   * Walks every page of a cursor-paginated endpoint.
   */
  async *#paginate<T>(path: string, params: ListParams & QueryParams): AsyncGenerator<T> {
    let cursor: string | undefined = params.cursor
    const seenCursors = new Set<string>()

    while (true) {
      const page: Page<T> = await this.#client.get<Page<T>>(path, { ...params, cursor })

      for (const item of page.data ?? []) {
        yield item
      }

      const next = page.pagination?.next_cursor

      /**
       * Stop on a repeated cursor rather than looping forever if the API ever
       * hands back the same page.
       */
      if (!page.pagination?.has_more || !next || seenCursors.has(next)) {
        return
      }

      seenCursors.add(next)
      cursor = next
    }
  }

  #cachedLicense(licenseKey: string): License | null {
    if (this.#config.licenseCacheTtl <= 0) {
      return null
    }

    const entry = this.#licenseCache.get(licenseKey)
    if (!entry) {
      return null
    }

    if (entry.expiresAt <= Date.now()) {
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
      expiresAt: Date.now() + this.#config.licenseCacheTtl,
    })
  }
}
