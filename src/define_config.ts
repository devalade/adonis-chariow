import { redact, Redacted } from './redacted.ts'

/**
 * Remembers which Pulse deliveries have already been processed, so a retry
 * does not run your handler twice. Provide your own to share the state across
 * processes (Redis, a database table, …).
 */
export type PulseDedupeStore = {
  seen(deliveryId: string): Promise<boolean> | boolean
  remember(deliveryId: string): Promise<void> | void
}

/**
 * Reads the current time in milliseconds. Injected rather than read from the
 * ambient clock so cache and de-duplication windows are testable.
 */
export type Clock = () => number

/** Configuration accepted from `config/chariow.ts`. */
export type ChariowConfig = {
  /**
   * Store API key, e.g. sk_live_… Server-side only — never ship it to a
   * browser or a mobile app.
   */
  readonly apiKey: string | Redacted<string>

  /**
   * Pulse signing secret, e.g. whsec_… This is NOT your API key: find it under
   * Automations → Pulses → your Pulse → Overview.
   *
   * Pass a record keyed by Pulse ID when several Pulses post to the same
   * endpoint; the secret is then resolved from the `x-pulse-id` header.
   */
  readonly pulseSecret?: string | Redacted<string> | Readonly<Record<string, string>>

  /** @default 'https://api.chariow.com/v1' */
  readonly baseUrl?: string

  /** Request deadline in milliseconds. @default 15000 */
  readonly timeout?: number

  /**
   * Retry attempts after a 429 or 5xx, for reads only. Checkout is never
   * retried, since a retried checkout is a duplicate sale. @default 2
   */
  readonly retries?: number

  /** Default `payment_currency` for checkouts that do not set one, e.g. 'XOF'. */
  readonly currency?: string

  /**
   * How long a license lookup stays cached, in milliseconds. The API allows
   * 100 requests per minute, so checking on every request would throttle a
   * live app. Set to 0 to disable. @default 60000
   */
  readonly licenseCacheTtl?: number

  /**
   * Days before a licence expires at which a subscription starts reading as
   * `expiring`, so you can prompt for renewal while access still works.
   * @default 7
   */
  readonly renewalWindowDays?: number

  /**
   * How long a subscription lookup stays cached, in milliseconds. Set to 0 to
   * disable. @default 60000
   */
  readonly subscriptionCacheTtl?: number

  /**
   * Pulse delivery de-duplication. Defaults to an in-memory store; set to
   * false to disable, or pass your own for cross-process de-duplication.
   */
  readonly dedupe?: false | PulseDedupeStore

  /** Overrides the global fetch. This is the seam tests use. */
  readonly fetch?: typeof globalThis.fetch

  /** Overrides the clock. This is the seam time-dependent tests use. */
  readonly now?: Clock
}

/** Configuration with defaults applied and secrets wrapped. */
export type ResolvedChariowConfig = {
  readonly apiKey: Redacted<string>
  readonly pulseSecret: Redacted<string> | Readonly<Record<string, Redacted<string>>> | null
  readonly baseUrl: string
  readonly timeout: number
  readonly retries: number
  readonly currency: string | null
  readonly licenseCacheTtl: number
  readonly renewalWindowDays: number
  readonly subscriptionCacheTtl: number
  readonly dedupe: false | PulseDedupeStore | null
  readonly fetch: typeof globalThis.fetch | null
  readonly now: Clock
}

const DEFAULTS = {
  baseUrl: 'https://api.chariow.com/v1',
  timeout: 15_000,
  retries: 2,
  licenseCacheTtl: 60_000,
  renewalWindowDays: 7,
  subscriptionCacheTtl: 60_000,
} as const

/**
 * Defines the Chariow configuration. Used from `config/chariow.ts`.
 */
export function defineConfig(config: ChariowConfig): ChariowConfig {
  return config
}

/**
 * Wraps every configured Pulse secret, keeping the single-secret and
 * per-Pulse-secret forms apart.
 */
function resolvePulseSecret(
  configured: ChariowConfig['pulseSecret']
): ResolvedChariowConfig['pulseSecret'] {
  if (configured === undefined || configured === '') {
    return null
  }

  if (typeof configured === 'string' || configured instanceof Redacted) {
    return redact(configured)
  }

  const byPulseId: Record<string, Redacted<string>> = {}
  for (const [pulseId, secret] of Object.entries(configured)) {
    byPulseId[pulseId] = redact(secret)
  }

  return byPulseId
}

/**
 * Applies defaults, wraps secrets, and fails loudly on a missing API key —
 * which is otherwise a confusing 401 at the first call.
 *
 * @throws {Error} When no API key is configured. A missing key is a startup
 * defect, not an expected failure.
 */
export function resolveConfig(config: ChariowConfig): ResolvedChariowConfig {
  const apiKey = redact(typeof config.apiKey === 'string' ? config.apiKey : config.apiKey.reveal())

  if (apiKey.reveal() === '') {
    throw new Error(
      'Missing Chariow API key. Set CHARIOW_API_KEY in your .env — generate one at https://app.chariow.com/settings/api'
    )
  }

  return {
    apiKey,
    pulseSecret: resolvePulseSecret(config.pulseSecret),
    baseUrl: (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    timeout: config.timeout ?? DEFAULTS.timeout,
    retries: config.retries ?? DEFAULTS.retries,
    currency: config.currency ?? null,
    licenseCacheTtl: config.licenseCacheTtl ?? DEFAULTS.licenseCacheTtl,
    renewalWindowDays: config.renewalWindowDays ?? DEFAULTS.renewalWindowDays,
    subscriptionCacheTtl: config.subscriptionCacheTtl ?? DEFAULTS.subscriptionCacheTtl,
    dedupe: config.dedupe ?? null,
    fetch: config.fetch ?? null,
    now: config.now ?? Date.now,
  }
}
