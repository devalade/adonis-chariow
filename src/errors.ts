import { Exception } from '@adonisjs/core/exceptions'

/**
 * Shape of every Chariow response body, success or failure.
 */
type ErrorBody = {
  message?: string
  data?: unknown
  errors?: unknown
}

/**
 * Prefixes the message coming from Chariow so the cause is visible
 * without unwrapping the error.
 */
function withApiMessage(fallback: string, body: ErrorBody | string | null): string {
  if (typeof body === 'string') {
    return body.trim() ? `${body.trim()} (${fallback})` : fallback
  }

  const message = body?.message
  return message ? `${message} (${fallback})` : fallback
}

/**
 * Base class for every failed call to the Chariow API. Also used directly
 * for statuses we do not model explicitly.
 */
export class ChariowRequestError extends Exception {
  static code = 'E_CHARIOW_REQUEST'
  static status = 500

  /**
   * HTTP status returned by Chariow. Null when the request never
   * completed (network failure or timeout).
   */
  declare responseStatus: number | null

  /**
   * Parsed response body, or the raw text when it was not JSON.
   */
  declare responseBody: ErrorBody | string | null

  constructor(
    fallbackMessage: string,
    responseStatus: number | null,
    responseBody: ErrorBody | string | null,
    options?: ErrorOptions
  ) {
    super(withApiMessage(fallbackMessage, responseBody), options)
    this.responseStatus = responseStatus
    this.responseBody = responseBody
  }
}

/**
 * The API key is missing, malformed or revoked.
 */
export class ChariowUnauthorizedError extends ChariowRequestError {
  static code = 'E_CHARIOW_UNAUTHORIZED'
  static status = 401

  constructor(responseBody: ErrorBody | string | null, options?: ErrorOptions) {
    super('Chariow rejected the API key', 401, responseBody, options)
  }
}

/**
 * The resource does not exist, belongs to another store, or is unpublished.
 */
export class ChariowNotFoundError extends ChariowRequestError {
  static code = 'E_CHARIOW_NOT_FOUND'
  static status = 404

  constructor(responseBody: ErrorBody | string | null, options?: ErrorOptions) {
    super('Chariow resource not found', 404, responseBody, options)
  }
}

/**
 * Chariow rejected the payload. Field errors are kept as sent.
 */
export class ChariowValidationError extends ChariowRequestError {
  static code = 'E_CHARIOW_VALIDATION'
  static status = 422

  declare errors: Record<string, string[]>

  constructor(
    errors: Record<string, string[]>,
    responseBody: ErrorBody | string | null,
    options?: ErrorOptions
  ) {
    super('Chariow rejected the request payload', 422, responseBody, options)
    this.errors = errors
  }
}

/**
 * The 100 requests per minute budget for this API key is exhausted.
 */
export class ChariowRateLimitError extends ChariowRequestError {
  static code = 'E_CHARIOW_RATE_LIMIT'
  static status = 429

  /**
   * Seconds to wait, taken from the Retry-After header. Null when absent.
   */
  declare retryAfter: number | null

  constructor(
    retryAfter: number | null,
    responseBody: ErrorBody | string | null,
    options?: ErrorOptions
  ) {
    super('Chariow rate limit exceeded', 429, responseBody, options)
    this.retryAfter = retryAfter
  }
}

/**
 * A request on the Pulse endpoint did not carry a signature we could verify
 * against the Pulse signing secret.
 */
export class ChariowInvalidSignatureError extends Exception {
  static code = 'E_CHARIOW_INVALID_SIGNATURE'
  static status = 401

  constructor(reason: string, options?: ErrorOptions) {
    super(`Invalid Chariow Pulse signature: ${reason}`, options)
  }
}

/**
 * Aliases matching the error codes, for callers who prefer to catch by code name.
 */
export const E_CHARIOW_REQUEST = ChariowRequestError
export const E_CHARIOW_UNAUTHORIZED = ChariowUnauthorizedError
export const E_CHARIOW_NOT_FOUND = ChariowNotFoundError
export const E_CHARIOW_VALIDATION = ChariowValidationError
export const E_CHARIOW_RATE_LIMIT = ChariowRateLimitError
export const E_CHARIOW_INVALID_SIGNATURE = ChariowInvalidSignatureError
