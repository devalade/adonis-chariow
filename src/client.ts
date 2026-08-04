import type { ResolvedChariowConfig } from './define_config.ts'
import type { ChariowEnvelope } from './types.ts'
import {
  ChariowNotFoundError,
  ChariowRateLimitError,
  ChariowRequestError,
  ChariowUnauthorizedError,
  ChariowValidationError,
} from './errors.ts'

export type QueryParams = Record<string, string | number | boolean | undefined | null>

type RequestOptions = {
  query?: QueryParams
  body?: unknown
  /**
   * Retry on 429/5xx. On by default for GET. Never enable it for checkout —
   * a retried checkout is a duplicate sale.
   */
  retry?: boolean
}

const USER_AGENT = 'adonis-chariow'

/**
 * Thin HTTP layer over the Chariow API: bearer auth, envelope unwrapping,
 * typed errors and retries for reads.
 */
export class ChariowClient {
  #config: ResolvedChariowConfig

  constructor(config: ResolvedChariowConfig) {
    this.#config = config
  }

  /**
   * Performs a GET and returns the unwrapped `data`.
   */
  get<T>(path: string, query?: QueryParams): Promise<T> {
    return this.request<T>('GET', path, { query })
  }

  /**
   * Performs a POST and returns the unwrapped `data`. Not retried unless
   * `retry` is explicitly set.
   */
  post<T>(path: string, body?: unknown, options?: { retry?: boolean }): Promise<T> {
    return this.request<T>('POST', path, { body, retry: options?.retry ?? false })
  }

  /**
   * Issues the request, retrying transient failures, and returns the
   * envelope's `data`.
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, options.query)
    const shouldRetry = options.retry ?? method === 'GET'
    const maxAttempts = shouldRetry ? this.#config.retries + 1 : 1

    let attempt = 0

    while (true) {
      attempt++

      const response = await this.#send(method, url, options.body)
      const body = await this.#readBody(response)

      if (response.ok) {
        return (body && typeof body === 'object' ? (body as ChariowEnvelope<T>).data : body) as T
      }

      const isTransient = response.status === 429 || response.status >= 500
      if (isTransient && attempt < maxAttempts) {
        await sleep(this.#backoffFor(response, attempt))
        continue
      }

      throw this.#toError(response, body)
    }
  }

  /**
   * Builds the absolute URL, dropping query values that are undefined or null.
   */
  #buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(`${this.#config.baseUrl}${path}`)

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) {
        continue
      }
      url.searchParams.set(key, String(value))
    }

    return url.toString()
  }

  async #send(method: string, url: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.#config.apiKey}`,
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const doFetch = this.#config.fetch ?? globalThis.fetch

    try {
      return await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#config.timeout),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ChariowRequestError(`Chariow request failed: ${reason}`, null, null, {
        cause: error,
      })
    }
  }

  /**
   * Parses the body as JSON, falling back to raw text so a proxy's HTML error
   * page surfaces as an error instead of a JSON.parse crash.
   */
  async #readBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '')

    if (!text) {
      return null
    }

    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * Honours Retry-After when present, otherwise backs off exponentially with
   * full jitter.
   */
  #backoffFor(response: Response, attempt: number): number {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))

    if (retryAfter !== null) {
      return retryAfter * 1000
    }

    return Math.random() * 300 * 2 ** (attempt - 1)
  }

  #toError(response: Response, body: unknown): Error {
    const parsed = (body ?? null) as Record<string, unknown> | string | null

    switch (response.status) {
      case 401:
      case 403:
        return new ChariowUnauthorizedError(parsed)
      case 404:
        return new ChariowNotFoundError(parsed)
      case 422:
        return new ChariowValidationError(extractFieldErrors(parsed), parsed)
      case 429:
        return new ChariowRateLimitError(
          parseRetryAfter(response.headers.get('retry-after')),
          parsed
        )
      default:
        return new ChariowRequestError(
          `Chariow responded with ${response.status}`,
          response.status,
          parsed
        )
    }
  }
}

/**
 * Pulls `{ field: [message] }` out of a 422 body, tolerating the empty array
 * the API sends when there are no field errors.
 */
function extractFieldErrors(body: Record<string, unknown> | string | null): Record<string, string[]> {
  if (!body || typeof body === 'string') {
    return {}
  }

  const errors = body.errors
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) {
    return {}
  }

  const result: Record<string, string[]> = {}
  for (const [field, messages] of Object.entries(errors as Record<string, unknown>)) {
    result[field] = Array.isArray(messages) ? messages.map(String) : [String(messages)]
  }

  return result
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) {
    return null
  }

  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
