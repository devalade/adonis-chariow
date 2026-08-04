/**
 * Remembers which Pulse deliveries have already been processed, so a retry
 * does not run your handler twice. Provide your own to share the state across
 * processes (Redis, a database table, …).
 */
export type PulseDedupeStore = {
  seen(deliveryId: string): Promise<boolean> | boolean
  remember(deliveryId: string): Promise<void> | void
}

export type ChariowConfig = {
  /**
   * Store API key, e.g. sk_live_… Server-side only — never ship it to a
   * browser or a mobile app.
   */
  apiKey: string

  /**
   * Pulse signing secret, e.g. whsec_… This is NOT your API key: find it under
   * Automations → Pulses → your Pulse → Overview.
   *
   * Pass a record keyed by Pulse ID when several Pulses post to the same
   * endpoint; the secret is then resolved from the `x-pulse-id` header.
   */
  pulseSecret?: string | Record<string, string>

  /** @default 'https://api.chariow.com/v1' */
  baseUrl?: string

  /** Request deadline in milliseconds. @default 15000 */
  timeout?: number

  /**
   * Retry attempts after a 429 or 5xx, for reads only. Checkout is never
   * retried, since a retried checkout is a duplicate sale. @default 2
   */
  retries?: number

  /**
   * Default `payment_currency` for checkouts that do not set one, e.g. 'XOF'.
   */
  currency?: string

  /**
   * How long a license lookup stays cached, in milliseconds. The API allows
   * 100 requests per minute, so checking on every request would throttle a
   * live app. Set to 0 to disable. @default 60000
   */
  licenseCacheTtl?: number

  /**
   * Pulse delivery de-duplication. Defaults to an in-memory store; set to
   * false to disable, or pass your own for cross-process de-duplication.
   */
  dedupe?: false | PulseDedupeStore

  /**
   * Overrides the global fetch. This is the seam tests use.
   */
  fetch?: typeof globalThis.fetch
}

export type ResolvedChariowConfig = {
  apiKey: string
  pulseSecret: string | Record<string, string> | null
  baseUrl: string
  timeout: number
  retries: number
  currency: string | null
  licenseCacheTtl: number
  dedupe: false | PulseDedupeStore | null
  fetch: typeof globalThis.fetch | null
}

const DEFAULTS = {
  baseUrl: 'https://api.chariow.com/v1',
  timeout: 15_000,
  retries: 2,
  licenseCacheTtl: 60_000,
} as const

/**
 * Defines the Chariow configuration. Used from `config/chariow.ts`.
 */
export function defineConfig(config: ChariowConfig): ChariowConfig {
  return config
}

/**
 * Applies defaults and fails loudly on a missing API key, which is otherwise
 * a confusing 401 at the first call.
 */
export function resolveConfig(config: ChariowConfig): ResolvedChariowConfig {
  if (!config.apiKey) {
    throw new Error(
      'Missing Chariow API key. Set CHARIOW_API_KEY in your .env — generate one at https://app.chariow.com/settings/api'
    )
  }

  return {
    apiKey: config.apiKey,
    pulseSecret: config.pulseSecret ?? null,
    baseUrl: (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    timeout: config.timeout ?? DEFAULTS.timeout,
    retries: config.retries ?? DEFAULTS.retries,
    currency: config.currency ?? null,
    licenseCacheTtl: config.licenseCacheTtl ?? DEFAULTS.licenseCacheTtl,
    dedupe: config.dedupe ?? null,
    fetch: config.fetch ?? null,
  }
}
