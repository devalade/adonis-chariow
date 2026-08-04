import { Result } from 'better-result'
import { z } from 'zod'

import type { ResolvedChariowConfig } from './define_config.ts'
import {
  ChariowNotFound,
  ChariowRateLimited,
  ChariowRequestFailed,
  ChariowResponseUnexpected,
  ChariowUnauthorized,
  ChariowValidationFailed,
  toShapeIssues,
  type ChariowApiFailure,
} from './failures.ts'
import { EnvelopeSchema } from './schemas.ts'

/** Query string values a request may carry. Absent values are dropped. */
export type QueryParams = Readonly<Record<string, string | number | boolean | undefined | null>>

type RequestOptions<S extends z.ZodType> = {
  /** Names the call in failures and telemetry, e.g. `getStore`. */
  readonly operation: string
  /** Parses the envelope's `data` into the value callers receive. */
  readonly schema: S
  readonly query?: QueryParams
  readonly body?: unknown
  /**
   * Retry on 429/5xx. On by default for GET. Never enable it for checkout —
   * a retried checkout is a duplicate sale.
   */
  readonly retry?: boolean
}

const USER_AGENT = 'adonis-chariow'

/**
 * The outbound adapter for the Chariow HTTP API. It owns authentication,
 * retries, envelope unwrapping and response parsing, and reports every
 * expected failure through the returned result rather than by throwing.
 */
export class ChariowClient {
  readonly #config: ResolvedChariowConfig

  constructor(config: ResolvedChariowConfig) {
    this.#config = config
  }

  /**
   * Performs a GET and parses the envelope's `data`.
   *
   * @template S - The schema for the response data.
   * @returns The parsed value, or the failure that stopped the call.
   */
  get<S extends z.ZodType>(
    path: string,
    options: Omit<RequestOptions<S>, 'body'>
  ): Promise<Result<z.infer<S>, ChariowApiFailure>> {
    return this.request('GET', path, options)
  }

  /**
   * Performs a POST and parses the envelope's `data`. Not retried unless
   * `retry` is explicitly set.
   *
   * @template S - The schema for the response data.
   * @returns The parsed value, or the failure that stopped the call.
   */
  post<S extends z.ZodType>(
    path: string,
    options: RequestOptions<S>
  ): Promise<Result<z.infer<S>, ChariowApiFailure>> {
    return this.request('POST', path, { retry: false, ...options })
  }

  /**
   * Issues the request, retrying transient failures, and parses the response.
   *
   * @template S - The schema for the response data.
   * @returns The parsed value, or the failure that stopped the call.
   */
  async request<S extends z.ZodType>(
    method: string,
    path: string,
    options: RequestOptions<S>
  ): Promise<Result<z.infer<S>, ChariowApiFailure>> {
    const url = this.#buildUrl(path, options.query)
    const shouldRetry = options.retry ?? method === 'GET'
    const maxAttempts = shouldRetry ? this.#config.retries + 1 : 1

    let attempt = 0

    while (true) {
      attempt++

      const sent = await this.#send(method, url, options.body, options.operation)
      if (Result.isError(sent)) {
        return sent
      }

      const response = sent.value
      const body = await this.#readBody(response)

      if (response.ok) {
        return this.#parse(body, options)
      }

      const isTransient = response.status === 429 || response.status >= 500
      if (isTransient && attempt < maxAttempts) {
        await sleep(this.#backoffFor(response, attempt))
        continue
      }

      return Result.err(this.#toFailure(response, body, options.operation))
    }
  }

  /**
   * Unwraps the envelope and parses `data`. A body that does not match the
   * documented shape fails loudly instead of reaching callers half-built.
   */
  #parse<S extends z.ZodType>(
    body: unknown,
    options: RequestOptions<S>
  ): Result<z.infer<S>, ChariowApiFailure> {
    const envelope = EnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      return Result.err(
        new ChariowResponseUnexpected({
          operation: options.operation,
          issues: toShapeIssues(envelope.error.issues),
          message: `Chariow returned a body that is not an API envelope during ${options.operation}`,
        })
      )
    }

    const data = options.schema.safeParse(envelope.data.data)
    if (!data.success) {
      return Result.err(
        new ChariowResponseUnexpected({
          operation: options.operation,
          issues: toShapeIssues(data.error.issues),
          message: `Chariow returned an unexpected shape during ${options.operation}`,
        })
      )
    }

    return Result.ok(data.data)
  }

  /** Builds the absolute URL, dropping query values that are undefined or null. */
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

  async #send(
    method: string,
    url: string,
    body: unknown,
    operation: string
  ): Promise<Result<Response, ChariowRequestFailed>> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.#config.apiKey.reveal()}`,
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const doFetch = this.#config.fetch ?? globalThis.fetch

    try {
      const response = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#config.timeout),
      })

      return Result.ok(response)
    } catch (cause: unknown) {
      return Result.err(
        new ChariowRequestFailed({
          operation,
          responseStatus: null,
          apiMessage: null,
          cause,
          message: `Chariow request failed during ${operation}: ${describeCause(cause)}`,
        })
      )
    }
  }

  /**
   * Parses the body as JSON, falling back to raw text so a proxy's HTML error
   * page surfaces as a failure instead of a JSON.parse crash.
   */
  async #readBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '')

    if (text === '') {
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
   * full jitter. The jitter only spreads retries in time; nothing
   * user-visible depends on its randomness.
   */
  #backoffFor(response: Response, attempt: number): number {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))

    if (retryAfter !== null) {
      return retryAfter * 1000
    }

    return Math.random() * 300 * 2 ** (attempt - 1)
  }

  #toFailure(response: Response, body: unknown, operation: string): ChariowApiFailure {
    const apiMessage = readApiMessage(body)

    switch (response.status) {
      case 401:
      case 403:
        return new ChariowUnauthorized({
          operation,
          responseStatus: response.status,
          apiMessage,
          message: apiMessage ?? 'Chariow rejected the API key',
        })
      case 404:
        return new ChariowNotFound({
          operation,
          apiMessage,
          message: apiMessage ?? `Chariow resource not found during ${operation}`,
        })
      case 422:
        return new ChariowValidationFailed({
          operation,
          errors: readFieldErrors(body),
          apiMessage,
          message: apiMessage ?? `Chariow rejected the payload sent by ${operation}`,
        })
      case 429:
        return new ChariowRateLimited({
          operation,
          retryAfter: parseRetryAfter(response.headers.get('retry-after')),
          apiMessage,
          message: apiMessage ?? 'Chariow rate limit exceeded',
        })
      default:
        return new ChariowRequestFailed({
          operation,
          responseStatus: response.status,
          apiMessage,
          cause: null,
          message: apiMessage ?? `Chariow responded with ${response.status} during ${operation}`,
        })
    }
  }
}

/**
 * Reads Chariow's own message from a failure body. Error bodies are the one
 * place we cannot assume the documented envelope, since a proxy may answer
 * instead of the API.
 */
function readApiMessage(body: unknown): string | null {
  if (typeof body === 'string') {
    return body.trim() === '' ? null : body.trim().slice(0, 200)
  }

  const envelope = EnvelopeSchema.safeParse(body)
  return envelope.success ? (envelope.data.message ?? null) : null
}

/** Field errors carried by a 422, as sent. */
const FieldErrorsSchema = z.record(z.string(), z.array(z.string()))

/**
 * Pulls `{ field: [message] }` out of a 422 body, tolerating the empty array
 * the API sends when there are no field errors.
 */
function readFieldErrors(body: unknown): Readonly<Record<string, ReadonlyArray<string>>> {
  const envelope = EnvelopeSchema.safeParse(body)
  if (!envelope.success) {
    return {}
  }

  const errors = FieldErrorsSchema.safeParse(envelope.data.errors)
  return errors.success ? errors.data : {}
}

/** Describes an unknown thrown value without serialising it. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'TimeoutError' ? 'the request deadline elapsed' : cause.message
  }

  return typeof cause
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
