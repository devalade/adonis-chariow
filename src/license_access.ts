import type { License } from './schemas.ts'

/**
 * Why a license key was refused. `not_found` also covers a key that belongs
 * to another store.
 */
export type LicenseRefusal = 'not_found' | 'revoked' | 'expired' | 'inactive'

/**
 * Whether a license key may use the application.
 *
 * A refusal always carries a reason so callers can say something useful —
 * "your licence expired" reads differently from "no such key".
 */
export type LicenseCheck =
  | { readonly valid: true; readonly license: License }
  | { readonly valid: false; readonly license: License | null; readonly reason: LicenseRefusal }

/**
 * Decides whether a license grants access.
 *
 * This is the whole paywall rule in one pure function: no I/O, no clock, no
 * cache. Order matters — a revoked license that has also expired should read
 * as revoked, because that is the fact the customer needs to act on.
 */
export function decideLicenseAccess(license: License): LicenseCheck {
  if (license.status === 'revoked') {
    return { valid: false, license, reason: 'revoked' }
  }

  if (license.is_expired || license.status === 'expired') {
    return { valid: false, license, reason: 'expired' }
  }

  /**
   * Covers `pending_activation` too: a license nobody has activated yet does
   * not grant access.
   */
  if (!license.is_active) {
    return { valid: false, license, reason: 'inactive' }
  }

  return { valid: true, license }
}

/** The verdict for a key Chariow does not know. */
export const LICENSE_NOT_FOUND: LicenseCheck = {
  valid: false,
  license: null,
  reason: 'not_found',
}
