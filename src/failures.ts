import { TaggedError } from 'better-result'
import type { $ZodIssue } from 'zod/v4/core'

/**
 * A safe description of one place where a response or payload did not match
 * the documented shape. It carries the field path and the type-level reason,
 * never the received value, so a failure can be logged without leaking
 * customer data out of a payload.
 */
export type ShapeIssue = {
  readonly path: string
  readonly code: string
  readonly message: string
}

/**
 * Projects parser issues into safe telemetry fields.
 */
export function toShapeIssues(issues: ReadonlyArray<$ZodIssue>): ReadonlyArray<ShapeIssue> {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    code: issue.code,
    message: issue.message,
  }))
}

/**
 * The request never produced a classified HTTP response: the network failed,
 * the deadline elapsed, or Chariow answered with a status this package does
 * not model.
 */
export class ChariowRequestFailed extends TaggedError('ChariowRequestFailed')<{
  readonly operation: string
  readonly responseStatus: number | null
  readonly apiMessage: string | null
  readonly cause: unknown
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_REQUEST'
  readonly status = 500
}

/**
 * Chariow rejected the API key: it is missing, malformed, revoked, or lacks
 * access to the resource.
 */
export class ChariowUnauthorized extends TaggedError('ChariowUnauthorized')<{
  readonly operation: string
  readonly responseStatus: 401 | 403
  readonly apiMessage: string | null
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_UNAUTHORIZED'
  readonly status = 401
}

/**
 * The resource does not exist, belongs to another store, or is unpublished.
 */
export class ChariowNotFound extends TaggedError('ChariowNotFound')<{
  readonly operation: string
  readonly apiMessage: string | null
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_NOT_FOUND'
  readonly status = 404
}

/**
 * Chariow rejected the request payload. `errors` holds its field errors as
 * sent, so a caller can surface them next to their own form fields.
 */
export class ChariowValidationFailed extends TaggedError('ChariowValidationFailed')<{
  readonly operation: string
  readonly errors: Readonly<Record<string, ReadonlyArray<string>>>
  readonly apiMessage: string | null
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_VALIDATION'
  readonly status = 422
}

/**
 * The API key exhausted its budget of 100 requests per minute. `retryAfter`
 * is the number of seconds Chariow asked us to wait, when it said.
 */
export class ChariowRateLimited extends TaggedError('ChariowRateLimited')<{
  readonly operation: string
  readonly retryAfter: number | null
  readonly apiMessage: string | null
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_RATE_LIMIT'
  readonly status = 429
}

/**
 * Chariow answered successfully but the body did not match the documented
 * shape, so no trustworthy value could be built from it.
 *
 * Failing here is deliberate. Handing a half-parsed object to application code
 * that the types promise is complete turns one upstream change into a class of
 * `undefined` bugs far from their cause.
 */
export class ChariowResponseUnexpected extends TaggedError('ChariowResponseUnexpected')<{
  readonly operation: string
  readonly issues: ReadonlyArray<ShapeIssue>
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_RESPONSE'
  readonly status = 502
}

/**
 * A request on the Pulse endpoint did not carry a signature that verifies
 * against the Pulse signing secret, so it cannot be treated as coming from
 * Chariow.
 */
export class PulseSignatureInvalid extends TaggedError('PulseSignatureInvalid')<{
  readonly reason: string
  readonly pulseId: string | null
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_INVALID_SIGNATURE'
  readonly status = 401
}

/**
 * The signature verified, but the body was not a Pulse payload this package
 * recognises.
 */
export class PulsePayloadUnexpected extends TaggedError('PulsePayloadUnexpected')<{
  readonly pulseId: string | null
  readonly issues: ReadonlyArray<ShapeIssue>
  readonly message: string
}> {
  readonly code = 'E_CHARIOW_PULSE_PAYLOAD'
  readonly status = 400
}

/**
 * Every expected failure a call to the Chariow API can produce.
 */
export type ChariowApiFailure =
  | ChariowRequestFailed
  | ChariowUnauthorized
  | ChariowNotFound
  | ChariowValidationFailed
  | ChariowRateLimited
  | ChariowResponseUnexpected

/**
 * Every expected failure receiving a Pulse delivery can produce.
 */
export type PulseFailure = PulseSignatureInvalid | PulsePayloadUnexpected

/**
 * Any expected failure this package produces.
 */
export type ChariowFailure = ChariowApiFailure | PulseFailure

/**
 * Recognises this package's failures among arbitrary caught values.
 */
export function isChariowFailure(value: unknown): value is ChariowFailure {
  return (
    value instanceof ChariowRequestFailed ||
    value instanceof ChariowUnauthorized ||
    value instanceof ChariowNotFound ||
    value instanceof ChariowValidationFailed ||
    value instanceof ChariowRateLimited ||
    value instanceof ChariowResponseUnexpected ||
    value instanceof PulseSignatureInvalid ||
    value instanceof PulsePayloadUnexpected
  )
}
