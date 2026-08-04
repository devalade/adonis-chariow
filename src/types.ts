/**
 * Types transcribed from the Chariow OpenAPI 3.1 spec, vendored at
 * resources/openapi.json. Keys keep the API's own snake_case so a payload
 * copied out of https://chariow.dev type-checks as-is.
 */

/*
|--------------------------------------------------------------------------
| Envelope and pagination
|--------------------------------------------------------------------------
*/

/**
 * Every Chariow response body has this shape.
 */
export type ChariowEnvelope<T> = {
  message: string
  data: T
  errors: unknown
}

export type Pagination = {
  next_cursor: string | null
  prev_cursor: string | null
  has_more: boolean
}

/**
 * One page of a cursor-paginated listing.
 */
export type Page<T> = {
  data: T[]
  pagination: Pagination
}

/**
 * Query parameters shared by every listing endpoint.
 */
export type ListParams = {
  /** Items per page, max 100. Defaults to 10 server-side. */
  per_page?: number
  cursor?: string
}

/*
|--------------------------------------------------------------------------
| Shared value objects
|--------------------------------------------------------------------------
*/

export type Amount = {
  /** Numeric amount, e.g. 99 for $99.00 */
  value: number
  /** Human readable amount with the currency symbol */
  formatted: string
  /** Abbreviated amount, e.g. 5K, 1.25M */
  short: string
  /** ISO 4217 three-letter currency code */
  currency: string
}

export type Country = {
  code: string
  name: string
}

export type StoreSimplified = {
  id: string
  name: string
}

export type ProductSimplified = {
  id: string
  name: string
  slug: string
}

export type CustomerSimplified = {
  id: string
  name: string
  email: string
}

export type DiscountSimplified = {
  id: string
  code: string
  type: string
}

/**
 * Chariow returns several enum-ish fields as a value/label pair.
 */
export type LabelledValue = {
  value: string
  label: string
  description?: string
}

/*
|--------------------------------------------------------------------------
| Store
|--------------------------------------------------------------------------
*/

export type Store = {
  id: string
  name: string
  description: string | null
  logo_url: string | null
  url: string
  social_links: {
    telegram: string | null
    instagram: string | null
    facebook: string | null
    x: string | null
    linkedin: string | null
    youtube: string | null
    tiktok: string | null
    discord: string | null
  }
  status: string
  /** Theme and appearance settings. Conditional. */
  appearance: Record<string, unknown> | null
  stats: Record<string, unknown>
}

/*
|--------------------------------------------------------------------------
| Products
|--------------------------------------------------------------------------
*/

export type ProductType = 'downloadable' | 'course' | 'license' | 'service' | 'bundle' | 'coaching'

export type ProductField = {
  order: number
  name: string
  label: string
  type: Record<string, unknown>
  is_required: boolean
  placeholder: string | null
  help_text: string | null
}

export type Product = {
  id: string
  name: string
  slug: string
  description: string | null
  type: ProductType
  category: { value: string; label: string }
  status: string
  is_free: boolean
  pictures: {
    thumbnail: string | null
    cover: string | null
  }
  pricing: {
    type: string
    price: Amount
    current_price: Amount
    effective: Amount
    minimum_price: Amount | null
    suggested_price: Amount | null
    price_off: number | null
  }
  has_variant_pricing: boolean
  /** Present only for limited quantity products. */
  quantity: Record<string, unknown> | null
  settings: {
    is_shipping_address_required: boolean
  }
  rating: {
    average: number
    count: number
  }
  on_sale_until: string | null
  /** Null when the store owner hides it. */
  sales_count: Record<string, unknown> | null
  /** Conditional. */
  seo: {
    meta_title: string | null
    meta_description: string | null
    meta_keywords: string | null
    canonical_url: string | null
    og_image: Record<string, unknown> | null
  } | null
  custom_cta_text: {
    value: string | null
    label: string | null
  }
  /** Custom fields defined for the product. Conditional. */
  fields: ProductField[] | null
  /** Conditional. */
  store: StoreSimplified | null
  /** Present only for bundle products. */
  bundle: {
    products: Record<string, unknown>[]
    savings: Record<string, unknown>
  } | null
}

export type ProductListParams = ListParams & {
  search?: string
  category?: string
  type?: ProductType
}

/*
|--------------------------------------------------------------------------
| Checkout
|--------------------------------------------------------------------------
*/

export type CheckoutPayload = {
  /** Product public ID or slug */
  product_id: string
  price_variant_id?: string
  email: string
  first_name: string
  last_name: string
  phone: {
    number: string
    country_code: string
  }
  discount_code?: string
  affiliate_code?: string
  /** ISO 4217 currency code. Filled from `config.currency` when omitted. */
  payment_currency?: string
  campaign_id?: string
  custom_fields?: Record<string, unknown>
  redirect_url?: string
  /** Max 10 keys, 255 characters per value. Echoed back in Pulse payloads. */
  custom_metadata?: Record<string, string>
  /**
   * The buyer's IP. Filled from `ctx.request.ip()` when a context is passed to
   * `checkout.create()`, so Chariow resolves the buyer's country and not your
   * server's.
   */
  customer_ip?: string
  /** Required for products with shipping enabled. */
  shipping?: {
    address?: string
    city?: string
    state?: string
    /** ISO 3166-1 alpha-2 country code */
    country?: string
    zip?: string
  }
}

export type CheckoutResult = {
  step: 'payment' | 'completed' | 'already_purchased'
  message: string | null
  purchase: SaleSummary
  payment: {
    checkout_url: string | null
    transaction_id: string | null
  }
}

/*
|--------------------------------------------------------------------------
| Sales
|--------------------------------------------------------------------------
*/

export type SaleStatus = 'awaiting_payment' | 'completed' | 'failed' | 'abandoned' | 'settled'

export type SaleSummary = {
  id: string
  status: string
  original_amount: Amount
  amount: Amount
  discount_amount: Amount
  payment: {
    amount: Amount
    status: string
    exchange_rate: Amount
    failure_error: { code: string; message: string } | null
  }
  shipping: {
    address: string | null
    city: string | null
    state: string | null
    country: string | null
    zip: string | null
  }
  invoice_download_url: string | null
  created_at: string
  completed_at: string | null
  store: StoreSimplified
  product: ProductSimplified
  customer: CustomerSimplified
  discount: DiscountSimplified | null
  /** Customer rating for this sale. */
  rate: Record<string, unknown> | null
  /** Conditional. */
  fulfillment: Record<string, unknown> | null
}

export type SaleDetail = {
  id: string
  status: string
  channel: Record<string, unknown> | null
  amount: Amount
  original_amount: Amount
  discount_amount: Amount
  settlement: {
    amount: Amount
    due_at: string | null
    done_at: string | null
    service_fee: Amount
  }
  download: {
    total: number
    last_at: string | null
  }
  invoice_download_url: string | null
  payment: {
    status: string
    transaction_id: string | null
    gateway: string | null
    method: string | null
    amount: Amount
    fee: Amount
    fee_rate: number | null
    interchange: {
      rate: number | null
      fee: Amount
    }
    exchange_rate: Amount
    failure_error: { code: string; message: string } | null
  }
  shipping: {
    address: string | null
    city: string | null
    state: string | null
    country: Country | null
    zip: string | null
  }
  context: {
    user_agent: string | null
    ip_address: string | null
    country: Country | null
    device_type: string | null
    locale: string | null
  }
  custom_fields_values: Record<string, unknown> | null
  campaign: Record<string, unknown> | null
  rating: Record<string, unknown> | null
  store: StoreSimplified
  product: ProductSimplified
  customer: CustomerSimplified
  discount: DiscountSimplified | null
  /** Conditional. */
  store_affiliate: Record<string, unknown> | null
  /** Conditional. */
  affiliate_commission: Record<string, unknown> | null
  is_reconciled: boolean
  last_reconciled_at: string | null
  failed_at: string | null
  awaiting_payment_at: string | null
  abandoned_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type SaleListParams = ListParams & {
  status?: SaleStatus
  customer_id?: string
  search?: string
  /** Y-m-d */
  start_date?: string
  /** Y-m-d */
  end_date?: string
}

/*
|--------------------------------------------------------------------------
| Customers
|--------------------------------------------------------------------------
*/

export type Customer = {
  id: string
  name: string
  first_name: string
  last_name: string
  email: string
  avatar_url: string | null
  phone: {
    number: string
    country_code: string
  }
  store: StoreSimplified
  created_at: string
  updated_at: string
}

export type CustomerListParams = ListParams & {
  search?: string
  start_date?: string
  end_date?: string
}

/*
|--------------------------------------------------------------------------
| Licenses
|--------------------------------------------------------------------------
*/

export type LicenseStatus = 'pending_activation' | 'active' | 'expired' | 'revoked'

export type License = {
  /** License public ID, e.g. lic_abc123 */
  id: string
  status: LicenseStatus
  customer: CustomerSimplified
  product: ProductSimplified
  license: {
    /** Full license key, e.g. ABC-123-XYZ-789 */
    key: string
    /** Masked for display, e.g. ABC-***-***-789 */
    masked_key: string
  }
  is_active: boolean
  is_expired: boolean
  can_activate: boolean
  activations: {
    count: number
    max: number
    remaining: number
  }
  certificate_url: string | null
  metadata: Record<string, unknown> | null
  activated_at: string | null
  /** Null for lifetime licenses. */
  expires_at: string | null
  expired_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export type Activation = {
  id: string
  activated_by: {
    ip: {
      value: string
      country: Country | null
    }
    user_agent: {
      browser: string
      platform: string
      version: string
    } | null
    device: string | null
  }
  metadata: Record<string, unknown> | null
  activated_at: string
  created_at: string
}

export type LicenseListParams = ListParams & {
  status?: LicenseStatus
  customer_id?: string
  product_id?: string
}

/**
 * Why a license key was refused. `not_found` also covers a key that belongs
 * to another store.
 */
export type LicenseCheckReason = 'not_found' | 'revoked' | 'expired' | 'inactive'

/**
 * Verdict returned by `licenses.check()`. Never throws for an unknown key —
 * a customer mistyping their key is a normal path, not an exception.
 */
export type LicenseCheck =
  | { valid: true; license: License }
  | { valid: false; license: License | null; reason: LicenseCheckReason }

/*
|--------------------------------------------------------------------------
| Discounts
|--------------------------------------------------------------------------
*/

export type Discount = {
  id: string
  name: string
  code: string
  type: 'percentage' | 'fixed'
  status: string
  value_off: {
    raw: number
    formatted: string
  }
  products: ProductSimplified[]
  store: StoreSimplified
  customer_email: string | null
  usage_count: number
  usage_limit: number | null
  start_date: string | null
  end_date: string | null
  is_auto_generated: boolean
  created_at: string
  updated_at: string
}

export type DiscountListParams = ListParams & {
  status?: 'active' | 'expired' | 'disabled'
  search?: string
  start_date?: string
  end_date?: string
}

/*
|--------------------------------------------------------------------------
| Pulses (webhooks)
|--------------------------------------------------------------------------
*/

/**
 * Event names as they arrive on the webhook, in the `x-pulse-event` header
 * and the payload's `event` field.
 *
 * Note the deliberate mismatch with `PulseTriggerValue` below: the webhook
 * uses dots, the Pulse configuration returned by `GET /pulses` uses
 * underscores. This is the API's own inconsistency, not a typo.
 */
export type PulseEvent =
  | 'successful.sale'
  | 'abandoned.sale'
  | 'failed.sale'
  | 'license.issued'
  | 'license.activated'
  | 'license.expired'
  | 'license.nearing_expiry'
  | 'license.revoked'
  | 'affiliate.joined'

/**
 * Trigger values stored on a Pulse configuration.
 */
export type PulseTriggerValue =
  | 'all'
  | 'successful_sale'
  | 'abandoned_sale'
  | 'failed_sale'
  | 'license_activated'
  | 'license_expired'
  | 'license_issued'
  | 'license_nearing_expiry'
  | 'license_revoked'
  | 'affiliate_joined'

export type PulseTrigger = {
  value: PulseTriggerValue
  label: string
  description: string
}

export type Pulse = {
  id: string
  url: string
  is_enabled: boolean
  /** How the Pulse was created, e.g. manual, zapier, make, n8n. */
  source: LabelledValue
  triggers: PulseTrigger[]
  products: ProductSimplified[]
  store: StoreSimplified
  is_editable: boolean
  created_at: string
  updated_at: string
}

export type PulseListParams = ListParams & {
  search?: string
}

/*
|--------------------------------------------------------------------------
| Pulse payloads
|--------------------------------------------------------------------------
*/

export type PulseCustomer = {
  id: string
  name: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  country: string | null
}

export type PulseProduct = {
  id: string
  name: string
  url: string
  price: Amount
}

export type PulseStore = {
  id: string
  name: string
  url: string
}

export type PulseSale = {
  id: string
  amount: Amount
  original_amount: Amount
  discount_amount: Amount
  settlement: {
    amount: Amount
    due_at: string | null
    done_at: string | null
    service_fee: Amount
    payment_fee: Amount
    fee: Amount
  }
  status: string
  created_at: string
  custom_fields: Record<string, unknown> | null
  custom_metadata: Record<string, string> | null
  completed_at: string | null
  abandoned_at: string | null
  failed_at: string | null
}

export type SalePulsePayload<E extends PulseEvent> = {
  event: E
  sale: PulseSale
  product: PulseProduct
  customer: PulseCustomer
  affiliate: Record<string, unknown> | null
  store: PulseStore
  /** Present only on test events sent from the dashboard. */
  note?: string
}

export type LicensePulsePayload<E extends PulseEvent> = {
  event: E
  license: License
  product: PulseProduct
  customer: PulseCustomer
  store: PulseStore
  note?: string
}

export type AffiliatePulsePayload = {
  event: 'affiliate.joined'
  affiliate: Affiliate
  store: PulseStore
  note?: string
}

/**
 * Maps each event to the payload your handler receives.
 */
export type PulsePayloads = {
  'successful.sale': SalePulsePayload<'successful.sale'>
  'abandoned.sale': SalePulsePayload<'abandoned.sale'>
  'failed.sale': SalePulsePayload<'failed.sale'>
  'license.issued': LicensePulsePayload<'license.issued'>
  'license.activated': LicensePulsePayload<'license.activated'>
  'license.expired': LicensePulsePayload<'license.expired'>
  'license.nearing_expiry': LicensePulsePayload<'license.nearing_expiry'>
  'license.revoked': LicensePulsePayload<'license.revoked'>
  'affiliate.joined': AffiliatePulsePayload
}

export type AnyPulsePayload = PulsePayloads[PulseEvent]

/*
|--------------------------------------------------------------------------
| Affiliates
|--------------------------------------------------------------------------
*/

export type Affiliate = {
  /** Store affiliate public ID, e.g. saff_xyz789 */
  id: string
  status: 'active' | 'suspended'
  /** How the affiliate joined, e.g. invitation, network. */
  source: LabelledValue
  total_visits: number
  total_sales: number
  total_earnings: Amount
  first_visit_at: string | null
  last_visit_at: string | null
  suspended_at: string | null
  suspended_reason: string | null
  /** Conditional. */
  account: {
    id: string
    pseudo: string | null
    country: Country
    status: string
    user: {
      id: string
      name: string
      email: string
      first_name: string
      last_name: string
    }
    created_at: string
  } | null
  /** Conditional. */
  store: StoreSimplified | null
  created_at: string
  updated_at: string
}

export type AffiliateInvitation = {
  /** Invitation public ID, e.g. affinv_abc123xyz */
  id: string
  email: string
  status: 'pending' | 'accepted' | 'expired' | 'cancelled'
  expires_at: string
  invited_by: { id: string; name: string } | null
  accepted_at: string | null
  created_at: string
}
