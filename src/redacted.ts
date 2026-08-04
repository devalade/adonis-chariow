/**
 * A secret that resists accidental disclosure. The wrapped value is absent
 * from string coercion, `console.log`, `util.inspect` and `JSON.stringify`, so
 * an API key cannot reach a log line, a test snapshot or an error payload
 * unless someone deliberately unwraps it.
 *
 * @template T - The wrapped secret.
 */
export class Redacted<T> {
  readonly #value: T

  constructor(value: T) {
    this.#value = value
  }

  /**
   * Returns the raw secret. Call this only at the point where the value is
   * used — an outbound Authorization header, an HMAC key — never to move it
   * around the program.
   */
  reveal(): T {
    return this.#value
  }

  /** @returns The placeholder, never the secret. */
  toString(): string {
    return '<redacted>'
  }

  /** @returns The placeholder, so `JSON.stringify` cannot leak the secret. */
  toJSON(): string {
    return '<redacted>'
  }

  /** @returns The placeholder, so `console.log` and `util.inspect` cannot leak the secret. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '<redacted>'
  }
}

/**
 * Wraps a secret, accepting an already-wrapped value so callers can pass
 * either a raw string from the environment or a value they redacted earlier.
 *
 * @template T - The wrapped secret.
 */
export function redact<T>(value: T | Redacted<T>): Redacted<T> {
  return value instanceof Redacted ? value : new Redacted(value)
}
