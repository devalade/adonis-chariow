import { decideLicenseAccess } from './license_access.ts'
import type { License } from './schemas.ts'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Where a customer stands with a product.
 *
 * `expiring` is still `active` — access continues, but the renewal window has
 * opened. Treat it as "working, ask them to pay again", not as a lockout.
 */
export type SubscriptionStatus = 'none' | 'pending' | 'active' | 'expiring' | 'expired' | 'revoked'

/** How the renewal window is measured. */
export type SubscriptionOptions = {
  /** Days before expiry at which a subscription starts reading as `expiring`. */
  readonly renewalWindowDays: number
}

/**
 * A customer's standing with one product, derived from the licences Chariow
 * holds for them.
 *
 * Chariow has no subscription resource; this is computed, not fetched.
 */
export type Subscription = {
  readonly status: SubscriptionStatus
  /** Whether access should be granted right now. True for `active` and `expiring`. */
  readonly isActive: boolean
  /** The licence this standing is derived from, or null when there is none. */
  readonly license: License | null
  readonly productId: string | null
  /** Null for a lifetime licence, and when there is no licence at all. */
  readonly expiresAt: Date | null
  /** Null for a lifetime licence. Negative once expiry has passed. */
  readonly daysRemaining: number | null
  readonly isLifetime: boolean
  /** True once the renewal window has opened, and after expiry. */
  readonly renewalDue: boolean
}

/** The standing of a customer who holds no licence for the product. */
const NO_SUBSCRIPTION: Subscription = {
  status: 'none',
  isActive: false,
  license: null,
  productId: null,
  expiresAt: null,
  daysRemaining: null,
  isLifetime: false,
  renewalDue: false,
}

/**
 * Derives a customer's standing from every licence they hold for a product.
 *
 * Renewing on Chariow means buying again, which issues a *new* licence rather
 * than extending the old one, so a long-standing customer accumulates several.
 * This picks the one that governs today and reports the renewal decision
 * around it.
 *
 * Pure: pass the current time in rather than reading a clock, so the renewal
 * boundary is testable.
 *
 * @param licenses - Every licence held for the product, in any order.
 * @param now - Current time in milliseconds.
 * @param options - How wide the renewal window is.
 */
export function decideSubscription(
  licenses: ReadonlyArray<License>,
  now: number,
  options: SubscriptionOptions
): Subscription {
  const governing = selectGoverningLicense(licenses)

  if (governing === null) {
    return NO_SUBSCRIPTION
  }

  return describe(governing, now, options)
}

/**
 * Picks the licence that decides today's answer.
 *
 * A licence that grants access always wins over one that does not, so an old
 * expired licence never masks a fresh purchase. Among those that grant access,
 * the one that lasts longest wins, because that is the access the customer
 * actually has. When none grant access the newest is reported, so the customer
 * is told about their latest attempt rather than an ancient one.
 */
function selectGoverningLicense(licenses: ReadonlyArray<License>): License | null {
  if (licenses.length === 0) {
    return null
  }

  const granting = licenses.filter((candidate) => decideLicenseAccess(candidate).valid)

  if (granting.length > 0) {
    return granting.reduce(longestLasting)
  }

  return licenses.reduce(mostRecentlyCreated)
}

/** Lifetime beats dated; otherwise the furthest expiry wins. */
function longestLasting(a: License, b: License): License {
  if (a.expires_at === null || a.expires_at === undefined) {
    return a
  }

  if (b.expires_at === null || b.expires_at === undefined) {
    return b
  }

  return Date.parse(b.expires_at) > Date.parse(a.expires_at) ? b : a
}

function mostRecentlyCreated(a: License, b: License): License {
  return createdAt(b) > createdAt(a) ? b : a
}

function createdAt(license: License): number {
  const parsed = license.created_at === undefined ? Number.NaN : Date.parse(license.created_at)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Turns the governing licence into a standing, mapping the licence refusal
 * reasons onto subscription vocabulary.
 */
function describe(license: License, now: number, options: SubscriptionOptions): Subscription {
  const access = decideLicenseAccess(license)
  const expiresAt = parseExpiry(license)
  const isLifetime = expiresAt === null
  const daysRemaining = expiresAt === null ? null : daysBetween(now, expiresAt.getTime())
  const productId = license.product?.id ?? null

  if (!access.valid) {
    const status = access.reason === 'inactive' ? 'pending' : access.reason
    return {
      status: status === 'not_found' ? 'none' : status,
      isActive: false,
      license,
      productId,
      expiresAt,
      daysRemaining,
      isLifetime,
      /** An expired subscription still needs renewing; a revoked one does not. */
      renewalDue: status === 'expired',
    }
  }

  /**
   * A lifetime licence never enters the renewal window — there is nothing to
   * renew, and nagging its holder to pay again would be a bug.
   */
  const expiring =
    daysRemaining !== null && !isLifetime && daysRemaining <= options.renewalWindowDays

  return {
    status: expiring ? 'expiring' : 'active',
    isActive: true,
    license,
    productId,
    expiresAt,
    daysRemaining,
    isLifetime,
    renewalDue: expiring,
  }
}

/** Reads `expires_at`, treating an unparseable value as lifetime rather than as expired. */
function parseExpiry(license: License): Date | null {
  if (license.expires_at === null || license.expires_at === undefined) {
    return null
  }

  const parsed = Date.parse(license.expires_at)
  return Number.isNaN(parsed) ? null : new Date(parsed)
}

/**
 * Whole days from `now` until `expiry`, rounded up so a subscription with any
 * time left reads as at least one day. Negative once expiry has passed.
 */
function daysBetween(now: number, expiry: number): number {
  return Math.ceil((expiry - now) / MS_PER_DAY)
}
