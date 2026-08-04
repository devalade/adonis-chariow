export { Chariow } from './src/chariow.ts'
export { ChariowClient } from './src/client.ts'
export { defineConfig, resolveConfig } from './src/define_config.ts'
export { decideLicenseAccess, LICENSE_NOT_FOUND } from './src/license_access.ts'
export { MemoryDedupeStore, PulsesResource } from './src/pulses.ts'
export { redact, Redacted } from './src/redacted.ts'
export {
  ChariowNotFound,
  ChariowRateLimited,
  ChariowRequestFailed,
  ChariowResponseUnexpected,
  ChariowUnauthorized,
  ChariowValidationFailed,
  isChariowFailure,
  PulsePayloadUnexpected,
  PulseSignatureInvalid,
  toShapeIssues,
} from './src/failures.ts'

export { configure } from './configure.ts'
export { stubsRoot } from './stubs/main.ts'

export type {
  ChariowApiFailure,
  ChariowFailure,
  PulseFailure,
  ShapeIssue,
} from './src/failures.ts'
export type {
  ChariowConfig,
  Clock,
  PulseDedupeStore,
  ResolvedChariowConfig,
} from './src/define_config.ts'
export type { LicenseCheck, LicenseRefusal } from './src/license_access.ts'
export type { PulseDelivery, PulseHandlers } from './src/pulses.ts'
export type { QueryParams } from './src/client.ts'
export type * from './src/schemas.ts'
