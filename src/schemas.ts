import { z } from 'zod'

/**
 * Schemas transcribed from the Chariow OpenAPI 3.1 spec, vendored at
 * resources/openapi.json. Keys keep the API's own snake_case so a payload
 * copied out of https://chariow.dev type-checks as-is.
 *
 * Response objects are parsed loosely: fields the spec documents are required
 * and rejected when missing, while unknown keys are preserved rather than
 * stripped. Chariow can therefore add fields without this package silently
 * dropping them, and can never remove a documented one without us saying so.
 */

/**
 * Object schema for data we receive. Unknown keys survive parsing so a new
 * field on Chariow's side reaches callers instead of disappearing.
 */
function response<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape)
}

/** Arbitrary nested data the spec documents only as "object". */
const openObject = z.looseObject({})

/*
|--------------------------------------------------------------------------
| Envelope and pagination
|--------------------------------------------------------------------------
*/

/**
 * Every Chariow response body has this shape. `data` stays unknown until the
 * endpoint's own schema parses it.
 */
export const EnvelopeSchema = response({
  message: z.string().optional(),
  /**
   * Optional so a failure body that carries only `message` still parses. On
   * the success path a missing `data` is caught by the endpoint's own schema,
   * which reports the field it expected.
   */
  data: z.unknown().optional(),
  errors: z.unknown().optional(),
})

/** Cursor pagination state returned alongside a page of results. */
export const PaginationSchema = response({
  next_cursor: z.string().nullable(),
  prev_cursor: z.string().nullable(),
  has_more: z.boolean(),
})

export type Pagination = z.infer<typeof PaginationSchema>

/**
 * Builds the schema for one page of a cursor-paginated listing.
 *
 * @template T - The schema for a single item.
 */
export function pageOf<T extends z.ZodType>(item: T) {
  return response({
    data: z.array(item),
    pagination: PaginationSchema,
  })
}

/**
 * One page of a cursor-paginated listing.
 *
 * @template T - The item type.
 */
export type Page<T> = {
  readonly data: ReadonlyArray<T>
  readonly pagination: Pagination
}

/** Query parameters shared by every listing endpoint. */
export type ListParams = {
  /** Items per page, max 100. Defaults to 10 server-side. */
  readonly per_page?: number
  readonly cursor?: string
}

/*
|--------------------------------------------------------------------------
| Shared value objects
|--------------------------------------------------------------------------
*/

/** A money amount, pre-formatted by Chariow for display. */
export const AmountSchema = response({
  value: z.number(),
  formatted: z.string(),
  short: z.string(),
  /** ISO 4217 three-letter currency code. */
  currency: z.string(),
})

export type Amount = z.infer<typeof AmountSchema>

/** An ISO 3166-1 country, as Chariow reports it. */
export const CountrySchema = response({ code: z.string(), name: z.string() })

export type Country = z.infer<typeof CountrySchema>

/** Chariow returns several enum-ish fields as a value/label pair. */
export const LabelledValueSchema = response({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
})

export type LabelledValue = z.infer<typeof LabelledValueSchema>

/** A store reduced to the fields nested resources carry. */
export const StoreSimplifiedSchema = response({ id: z.string(), name: z.string() })

export type StoreSimplified = z.infer<typeof StoreSimplifiedSchema>

/** A product reduced to the fields nested resources carry. */
export const ProductSimplifiedSchema = response({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
})

export type ProductSimplified = z.infer<typeof ProductSimplifiedSchema>

/** A customer reduced to the fields nested resources carry. */
export const CustomerSimplifiedSchema = response({
  id: z.string(),
  name: z.string(),
  email: z.string(),
})

export type CustomerSimplified = z.infer<typeof CustomerSimplifiedSchema>

/** A discount reduced to the fields nested resources carry. */
export const DiscountSimplifiedSchema = response({
  id: z.string(),
  code: z.string(),
  type: z.string(),
})

export type DiscountSimplified = z.infer<typeof DiscountSimplifiedSchema>

/*
|--------------------------------------------------------------------------
| Store
|--------------------------------------------------------------------------
*/

/** The store the API key belongs to. */
export const StoreSchema = response({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  logo_url: z.string().nullable(),
  url: z.string(),
  social_links: response({
    telegram: z.string().nullable(),
    instagram: z.string().nullable(),
    facebook: z.string().nullable(),
    x: z.string().nullable(),
    linkedin: z.string().nullable(),
    youtube: z.string().nullable(),
    tiktok: z.string().nullable(),
    discord: z.string().nullable(),
  }).optional(),
  status: z.string(),
  /** Theme and appearance settings. Conditional. */
  appearance: openObject.nullable().optional(),
  stats: openObject.optional(),
})

export type Store = z.infer<typeof StoreSchema>

/*
|--------------------------------------------------------------------------
| Products
|--------------------------------------------------------------------------
*/

/** The kinds of product a Chariow store can sell. */
export const ProductTypeSchema = z.enum([
  'downloadable',
  'course',
  'license',
  'service',
  'bundle',
  'coaching',
])

export type ProductType = z.infer<typeof ProductTypeSchema>

/** A custom field a product asks the buyer to fill in at checkout. */
export const ProductFieldSchema = response({
  order: z.number(),
  name: z.string(),
  label: z.string(),
  type: z.unknown(),
  is_required: z.boolean(),
  placeholder: z.string().nullable().optional(),
  help_text: z.string().nullable().optional(),
})

export type ProductField = z.infer<typeof ProductFieldSchema>

/** A published product. */
export const ProductSchema = response({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  type: ProductTypeSchema,
  category: response({ value: z.string(), label: z.string() }).optional(),
  status: z.string(),
  is_free: z.boolean(),
  pictures: response({
    thumbnail: z.string().nullable(),
    cover: z.string().nullable(),
  }).optional(),
  pricing: response({
    type: z.string(),
    price: AmountSchema,
    current_price: AmountSchema,
    effective: AmountSchema,
    minimum_price: AmountSchema.nullable().optional(),
    suggested_price: AmountSchema.nullable().optional(),
    price_off: z.number().nullable().optional(),
  }),
  has_variant_pricing: z.boolean().optional(),
  /** Present only for limited quantity products. */
  quantity: openObject.nullable().optional(),
  settings: response({ is_shipping_address_required: z.boolean() }).optional(),
  rating: response({ average: z.number(), count: z.number() }).optional(),
  on_sale_until: z.string().nullable().optional(),
  /** Null when the store owner hides it. */
  sales_count: z.unknown().optional(),
  /** Conditional. */
  seo: openObject.nullable().optional(),
  custom_cta_text: response({
    value: z.string().nullable(),
    label: z.string().nullable(),
  }).optional(),
  /** Custom fields defined for the product. Conditional. */
  fields: z.array(ProductFieldSchema).nullable().optional(),
  /** Conditional. */
  store: StoreSimplifiedSchema.nullable().optional(),
  /** Present only for bundle products. */
  bundle: openObject.nullable().optional(),
})

export type Product = z.infer<typeof ProductSchema>

/** Filters accepted by the product listing. */
export type ProductListParams = ListParams & {
  readonly search?: string
  readonly category?: string
  readonly type?: ProductType
}

/*
|--------------------------------------------------------------------------
| Sales
|--------------------------------------------------------------------------
*/

/** Lifecycle states a sale moves through. */
export const SaleStatusSchema = z.enum([
  'awaiting_payment',
  'completed',
  'failed',
  'abandoned',
  'settled',
])

export type SaleStatus = z.infer<typeof SaleStatusSchema>

/** A sale as it appears in listings and in the checkout response. */
export const SaleSummarySchema = response({
  id: z.string(),
  status: z.string(),
  original_amount: AmountSchema.optional(),
  amount: AmountSchema.optional(),
  discount_amount: AmountSchema.optional(),
  payment: openObject.optional(),
  shipping: openObject.optional(),
  invoice_download_url: z.string().nullable().optional(),
  created_at: z.string().optional(),
  completed_at: z.string().nullable().optional(),
  store: StoreSimplifiedSchema.optional(),
  product: ProductSimplifiedSchema.optional(),
  customer: CustomerSimplifiedSchema.optional(),
  discount: DiscountSimplifiedSchema.nullable().optional(),
  /** Customer rating for this sale. */
  rate: z.unknown().optional(),
  /** Conditional. */
  fulfillment: z.unknown().optional(),
})

export type SaleSummary = z.infer<typeof SaleSummarySchema>

/** A single sale with payment, settlement and context detail. */
export const SaleDetailSchema = response({
  id: z.string(),
  status: z.string(),
  channel: z.unknown().optional(),
  amount: AmountSchema,
  original_amount: AmountSchema,
  discount_amount: AmountSchema,
  settlement: openObject.optional(),
  download: response({ total: z.number(), last_at: z.string().nullable() }).optional(),
  invoice_download_url: z.string().nullable().optional(),
  payment: openObject.optional(),
  shipping: openObject.optional(),
  context: openObject.optional(),
  custom_fields_values: openObject.nullable().optional(),
  campaign: z.unknown().optional(),
  rating: z.unknown().optional(),
  store: StoreSimplifiedSchema,
  product: ProductSimplifiedSchema,
  customer: CustomerSimplifiedSchema,
  discount: DiscountSimplifiedSchema.nullable().optional(),
  /** Conditional. */
  store_affiliate: z.unknown().optional(),
  /** Conditional. */
  affiliate_commission: z.unknown().optional(),
  is_reconciled: z.boolean().optional(),
  last_reconciled_at: z.string().nullable().optional(),
  failed_at: z.string().nullable().optional(),
  awaiting_payment_at: z.string().nullable().optional(),
  abandoned_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
})

export type SaleDetail = z.infer<typeof SaleDetailSchema>

/** Filters accepted by the sales listing. */
export type SaleListParams = ListParams & {
  readonly status?: SaleStatus
  readonly customer_id?: string
  readonly search?: string
  /** Y-m-d */
  readonly start_date?: string
  /** Y-m-d */
  readonly end_date?: string
}

/*
|--------------------------------------------------------------------------
| Checkout
|--------------------------------------------------------------------------
*/

/**
 * A checkout request. Rejects unknown fields: a misspelled key here would
 * otherwise be silently dropped and produce a sale with missing data.
 */
export const CheckoutPayloadSchema = z.strictObject({
  /** Product public ID or slug. */
  product_id: z.string(),
  price_variant_id: z.string().optional(),
  email: z.email().max(255),
  first_name: z.string().max(50),
  last_name: z.string().max(50),
  phone: z.strictObject({
    number: z.string(),
    country_code: z.string().max(10),
  }),
  discount_code: z.string().max(100).optional(),
  affiliate_code: z.string().max(50).optional(),
  /** ISO 4217 currency code. Filled from `config.currency` when omitted. */
  payment_currency: z.string().optional(),
  campaign_id: z.string().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
  redirect_url: z.url().max(2048).optional(),
  /** Max 10 keys, 255 characters per value. Echoed back in Pulse payloads. */
  custom_metadata: z.record(z.string(), z.string().max(255)).optional(),
  /**
   * The buyer's IP. Filled from `ctx.request.ip()` when a context is passed to
   * `checkout.create()`, so Chariow resolves the buyer's country and not your
   * server's.
   */
  customer_ip: z.string().optional(),
  /** Required for products with shipping enabled. */
  shipping: z
    .strictObject({
      address: z.string().max(255).optional(),
      city: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      /** ISO 3166-1 alpha-2 country code. */
      country: z.string().optional(),
      zip: z.string().max(20).optional(),
    })
    .optional(),
})

export type CheckoutPayload = z.input<typeof CheckoutPayloadSchema>

/** The outcome of starting a checkout. */
export const CheckoutResultSchema = response({
  step: z.enum(['payment', 'completed', 'already_purchased']),
  message: z.string().nullable().optional(),
  purchase: SaleSummarySchema.optional(),
  payment: response({
    checkout_url: z.string().nullable(),
    transaction_id: z.string().nullable(),
  }).optional(),
})

export type CheckoutResult = z.infer<typeof CheckoutResultSchema>

/*
|--------------------------------------------------------------------------
| Customers
|--------------------------------------------------------------------------
*/

/** A customer of the store. */
export const CustomerSchema = response({
  id: z.string(),
  name: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string(),
  avatar_url: z.string().nullable().optional(),
  phone: response({
    number: z.string(),
    country_code: z.string(),
  }).optional(),
  store: StoreSimplifiedSchema.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type Customer = z.infer<typeof CustomerSchema>

/** Filters accepted by the customer listing. */
export type CustomerListParams = ListParams & {
  readonly search?: string
  readonly start_date?: string
  readonly end_date?: string
}

/*
|--------------------------------------------------------------------------
| Licenses
|--------------------------------------------------------------------------
*/

/** Lifecycle states a license moves through. */
export const LicenseStatusSchema = z.enum(['pending_activation', 'active', 'expired', 'revoked'])

export type LicenseStatus = z.infer<typeof LicenseStatusSchema>

/**
 * A license key and its access-granting state.
 *
 * `status`, `is_active` and `is_expired` are required because they decide
 * whether someone gets into your app. A response missing them must fail rather
 * than default to a permissive answer.
 */
export const LicenseSchema = response({
  /** License public ID, e.g. lic_abc123. */
  id: z.string(),
  status: LicenseStatusSchema,
  customer: CustomerSimplifiedSchema.optional(),
  product: ProductSimplifiedSchema.optional(),
  license: response({
    /** Full license key, e.g. ABC-123-XYZ-789. */
    key: z.string(),
    /** Masked for display, e.g. ABC-***-***-789. */
    masked_key: z.string().optional(),
  }).optional(),
  is_active: z.boolean(),
  is_expired: z.boolean(),
  can_activate: z.boolean(),
  activations: response({
    count: z.number(),
    max: z.number(),
    remaining: z.number(),
  }).optional(),
  certificate_url: z.string().nullable().optional(),
  metadata: openObject.nullable().optional(),
  activated_at: z.string().nullable().optional(),
  /** Null for lifetime licenses. */
  expires_at: z.string().nullable().optional(),
  expired_at: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type License = z.infer<typeof LicenseSchema>

/** One device activation of a license. */
export const ActivationSchema = response({
  id: z.string(),
  activated_by: openObject.optional(),
  metadata: openObject.nullable().optional(),
  activated_at: z.string().optional(),
  created_at: z.string().optional(),
})

export type Activation = z.infer<typeof ActivationSchema>

/** Filters accepted by the license listing. */
export type LicenseListParams = ListParams & {
  readonly status?: LicenseStatus
  readonly customer_id?: string
  readonly product_id?: string
}

/*
|--------------------------------------------------------------------------
| Discounts
|--------------------------------------------------------------------------
*/

/** A discount code. */
export const DiscountSchema = response({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  type: z.enum(['percentage', 'fixed']),
  status: z.string(),
  value_off: response({ raw: z.number(), formatted: z.string() }).optional(),
  products: z.array(ProductSimplifiedSchema).optional(),
  store: StoreSimplifiedSchema.optional(),
  customer_email: z.string().nullable().optional(),
  usage_count: z.number().optional(),
  usage_limit: z.number().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  is_auto_generated: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type Discount = z.infer<typeof DiscountSchema>

/** Filters accepted by the discount listing. */
export type DiscountListParams = ListParams & {
  readonly status?: 'active' | 'expired' | 'disabled'
  readonly search?: string
  readonly start_date?: string
  readonly end_date?: string
}

/*
|--------------------------------------------------------------------------
| Pulse configuration
|--------------------------------------------------------------------------
*/

/**
 * Trigger values stored on a Pulse configuration.
 *
 * Note the deliberate mismatch with `PulseEvent`: the configuration uses
 * underscores, the delivered webhook uses dots. That is the API's own
 * inconsistency, not a typo.
 */
export const PulseTriggerValueSchema = z.enum([
  'all',
  'successful_sale',
  'abandoned_sale',
  'failed_sale',
  'license_activated',
  'license_expired',
  'license_issued',
  'license_nearing_expiry',
  'license_revoked',
  'affiliate_joined',
])

export type PulseTriggerValue = z.infer<typeof PulseTriggerValueSchema>

/** One event a Pulse is subscribed to. */
export const PulseTriggerSchema = response({
  value: PulseTriggerValueSchema,
  label: z.string().optional(),
  description: z.string().optional(),
})

export type PulseTrigger = z.infer<typeof PulseTriggerSchema>

/** A configured webhook endpoint. */
export const PulseSchema = response({
  id: z.string(),
  url: z.string(),
  is_enabled: z.boolean(),
  /** How the Pulse was created, e.g. manual, zapier, make, n8n. */
  source: LabelledValueSchema.optional(),
  triggers: z.array(PulseTriggerSchema).optional(),
  products: z.array(ProductSimplifiedSchema).optional(),
  store: StoreSimplifiedSchema.optional(),
  is_editable: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type Pulse = z.infer<typeof PulseSchema>

/** Filters accepted by the Pulse listing. */
export type PulseListParams = ListParams & {
  readonly search?: string
}

/*
|--------------------------------------------------------------------------
| Affiliates
|--------------------------------------------------------------------------
*/

/** Someone promoting the store for commission. */
export const AffiliateSchema = response({
  /** Store affiliate public ID, e.g. saff_xyz789. */
  id: z.string(),
  status: z.enum(['active', 'suspended']),
  /** How the affiliate joined, e.g. invitation, network. */
  source: LabelledValueSchema.optional(),
  total_visits: z.number().optional(),
  total_sales: z.number().optional(),
  total_earnings: AmountSchema.optional(),
  first_visit_at: z.string().nullable().optional(),
  last_visit_at: z.string().nullable().optional(),
  suspended_at: z.string().nullable().optional(),
  suspended_reason: z.string().nullable().optional(),
  /** Conditional. */
  account: openObject.nullable().optional(),
  /** Conditional. */
  store: StoreSimplifiedSchema.nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})

export type Affiliate = z.infer<typeof AffiliateSchema>

/** An invitation to join the affiliate programme. */
export const AffiliateInvitationSchema = response({
  /** Invitation public ID, e.g. affinv_abc123xyz. */
  id: z.string(),
  email: z.string(),
  status: z.enum(['pending', 'accepted', 'expired', 'cancelled']),
  expires_at: z.string().optional(),
  invited_by: response({ id: z.string(), name: z.string() }).nullable().optional(),
  accepted_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
})

export type AffiliateInvitation = z.infer<typeof AffiliateInvitationSchema>

/*
|--------------------------------------------------------------------------
| Pulse payloads
|--------------------------------------------------------------------------
*/

/**
 * Event names as they arrive on the webhook, in the `x-pulse-event` header and
 * the payload's `event` field.
 */
export const PulseEventSchema = z.enum([
  'successful.sale',
  'abandoned.sale',
  'failed.sale',
  'license.issued',
  'license.activated',
  'license.expired',
  'license.nearing_expiry',
  'license.revoked',
  'affiliate.joined',
])

export type PulseEvent = z.infer<typeof PulseEventSchema>

/** The customer, as a Pulse payload describes them. */
export const PulseCustomerSchema = response({
  id: z.string(),
  name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string(),
  phone: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
})

export type PulseCustomer = z.infer<typeof PulseCustomerSchema>

/** The product, as a Pulse payload describes it. */
export const PulseProductSchema = response({
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
  price: AmountSchema.optional(),
})

export type PulseProduct = z.infer<typeof PulseProductSchema>

/** The store, as a Pulse payload describes it. */
export const PulseStoreSchema = response({
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
})

export type PulseStore = z.infer<typeof PulseStoreSchema>

/** The sale, as a Pulse payload describes it. */
export const PulseSaleSchema = response({
  id: z.string(),
  amount: AmountSchema.optional(),
  original_amount: AmountSchema.optional(),
  discount_amount: AmountSchema.optional(),
  settlement: openObject.optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  custom_fields: openObject.nullable().optional(),
  custom_metadata: z.record(z.string(), z.string()).nullable().optional(),
  completed_at: z.string().nullable().optional(),
  abandoned_at: z.string().nullable().optional(),
  failed_at: z.string().nullable().optional(),
})

export type PulseSale = z.infer<typeof PulseSaleSchema>

/**
 * Builds the payload schema for one of the sale events.
 *
 * `product`, `customer` and `store` are required: Chariow documents them on
 * every sale event, so callers get non-optional types rather than optional
 * chaining through fields that are always there.
 *
 * @template E - The event literal.
 */
function salePayload<E extends PulseEvent>(event: E) {
  return response({
    event: z.literal(event),
    sale: PulseSaleSchema,
    product: PulseProductSchema,
    customer: PulseCustomerSchema,
    affiliate: z.unknown().optional(),
    store: PulseStoreSchema,
    /** Present only on test events sent from the dashboard. */
    note: z.string().optional(),
  })
}

/**
 * Builds the payload schema for one of the license events.
 *
 * @template E - The event literal.
 */
function licensePayload<E extends PulseEvent>(event: E) {
  return response({
    event: z.literal(event),
    license: LicenseSchema,
    product: PulseProductSchema,
    customer: PulseCustomerSchema,
    store: PulseStoreSchema,
    note: z.string().optional(),
  })
}

/** The payload delivered for `affiliate.joined`. */
export const AffiliateJoinedPayloadSchema = response({
  event: z.literal('affiliate.joined'),
  affiliate: AffiliateSchema,
  store: PulseStoreSchema,
  note: z.string().optional(),
})

/**
 * Maps each event to the schema that parses its payload, and therefore to the
 * type your handler receives.
 */
export const PulsePayloadSchemas = {
  'successful.sale': salePayload('successful.sale'),
  'abandoned.sale': salePayload('abandoned.sale'),
  'failed.sale': salePayload('failed.sale'),
  'license.issued': licensePayload('license.issued'),
  'license.activated': licensePayload('license.activated'),
  'license.expired': licensePayload('license.expired'),
  'license.nearing_expiry': licensePayload('license.nearing_expiry'),
  'license.revoked': licensePayload('license.revoked'),
  'affiliate.joined': AffiliateJoinedPayloadSchema,
} as const

/**
 * The payload type delivered for each event.
 */
export type PulsePayloads = {
  [E in PulseEvent]: z.infer<(typeof PulsePayloadSchemas)[E]>
}

/** Any Pulse payload. */
export type AnyPulsePayload = PulsePayloads[PulseEvent]

/**
 * Just enough of a delivery to route it to the right payload schema. The
 * event name is read from the signed body, never from the unsigned header.
 */
export const PulseEnvelopeSchema = z.looseObject({ event: PulseEventSchema })
