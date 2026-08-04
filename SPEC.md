# SPEC — `@devalade/adonis-chariow`

Implementation contract. This file is the single source of truth for the worker.
Do not invent API surface beyond what is written here. `resources/openapi.json` is the
vendored Chariow OpenAPI 3.1 spec — all request/response types must be derived from it.

## Guiding principle: SIMPLE

The whole point of this package is that a Chariow integration in an AdonisJS app should be
three lines, not three files. Optimise every decision for "obvious on first read":

- **No mapping layer.** Request payloads and response objects keep the API's own `snake_case`
  keys exactly as documented at https://chariow.dev. A user can copy a payload out of the
  Chariow docs and it type-checks. Do not camel-case anything.
- **Few files, few concepts.** The whole runtime is 6 files under `src/`. Do not add
  abstract factories, registries, driver interfaces, or a plugin system.
- **One import.** `import chariow from '@devalade/adonis-chariow/services/main'` gives you
  everything.
- **Errors throw, except license checks.** Failed HTTP calls throw typed exceptions.
  `licenses.check()` never throws for an unknown/invalid key — it returns a verdict.

## Target

AdonisJS 7 (`@adonisjs/core@^7`), Node >= 24, ESM, TypeScript 6 with
`rewriteRelativeImportExtensions` — **relative imports in source must carry the `.ts`
extension** (e.g. `import { ChariowClient } from './client.ts'`).

Use native `fetch` and `node:crypto`. No runtime dependencies beyond `@adonisjs/core` (peer).

## API facts (verified against the live API — do not "correct" these)

| | |
|---|---|
| Base URL | `https://api.chariow.com/v1` |
| Auth | `Authorization: Bearer <apiKey>` (keys look like `sk_live_keyid_secret`) |
| Envelope | every response body is `{ message, data, errors }` |
| Pagination | `?cursor=&per_page=` → response also has `pagination: { next_cursor, prev_cursor, has_more }` |
| Rate limit | 100 req/min per key. `429` carries a `Retry-After` header (seconds) |
| Validation error | `422` with `errors: Record<string, string[]>` |
| Pulse signature | `x-chariow-signature: sha256=<64 lowercase hex>` = HMAC-SHA256 of the **raw body bytes**, key = the Pulse's own `whsec_…` secret. No timestamp in the scheme |
| Pulse idempotency | `x-pulse-delivery-id`, stable across retries (final retry can arrive ~3h after the first). **Absent** on dashboard test events |
| Other Pulse headers | `x-pulse-id`, `x-pulse-event` |

### Endpoints (20)

```
GET    /store
GET    /products                              ?per_page&cursor
GET    /products/{productId}
POST   /checkout
GET    /sales                                 ?per_page&cursor&status&product_id&customer_id
GET    /sales/{saleId}
GET    /customers                             ?per_page&cursor
GET    /customers/{customerId}
GET    /licenses                              ?per_page&cursor&status&customer_id&product_id
GET    /licenses/{licenseKey}
POST   /licenses/{licenseKey}/activate        { device_identifier? }
POST   /licenses/{licenseKey}/revoke
GET    /licenses/{licenseKey}/activations     ?per_page&cursor
GET    /discounts                             ?per_page&cursor
GET    /discounts/{discountId}
GET    /pulses                                ?per_page&cursor
GET    /pulses/{pulseId}
GET    /affiliates/{affiliateCode}
POST   /affiliates/invitations
```

Confirm every query parameter against `resources/openapi.json` before writing it.

## Files to produce

```
src/errors.ts        typed exceptions
src/types.ts         all request/response types, derived from resources/openapi.json
src/client.ts        ChariowClient — fetch, auth, envelope unwrap, retry
src/chariow.ts       Chariow — the resource namespaces
src/pulses.ts        signature verification + handle()
src/define_config.ts defineConfig
index.ts             public exports
providers/chariow_provider.ts
services/main.ts
configure.ts
commands/chariow_check.ts
commands/main.ts
stubs/config/chariow.stub
stubs/controllers/chariow_pulses_controller.stub
tests/*.spec.ts
README.md
```

---

## `src/errors.ts`

Use `createError` from `@adonisjs/core/exceptions` so these surface with the right HTTP
status through the app's exception handler.

| Export | Code | Status | Extra fields |
|---|---|---|---|
| `E_CHARIOW_REQUEST` | `E_CHARIOW_REQUEST` | 500 | `status`, `body` |
| `E_CHARIOW_UNAUTHORIZED` | `E_CHARIOW_UNAUTHORIZED` | 401 | |
| `E_CHARIOW_NOT_FOUND` | `E_CHARIOW_NOT_FOUND` | 404 | |
| `E_CHARIOW_VALIDATION` | `E_CHARIOW_VALIDATION` | 422 | `errors: Record<string, string[]>` |
| `E_CHARIOW_RATE_LIMIT` | `E_CHARIOW_RATE_LIMIT` | 429 | `retryAfter: number \| null` |
| `E_CHARIOW_INVALID_SIGNATURE` | `E_CHARIOW_INVALID_SIGNATURE` | 401 | |

Every error message must start with the Chariow `message` field from the response body when
one is present, so the cause is visible without unwrapping anything.

## `src/client.ts`

```ts
class ChariowClient {
  constructor(config: ResolvedChariowConfig)
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>
  post<T>(path: string, body?: unknown, options?: { retry?: boolean }): Promise<T>
  raw<T>(path, init): Promise<ChariowEnvelope<T>>   // used by paginated reads
}
```

Rules:

- `Authorization: Bearer <apiKey>`, `Accept: application/json`, `Content-Type: application/json`
  on requests with a body, and `User-Agent: adonis-chariow/<version>`.
- Deadline via `AbortSignal.timeout(config.timeout)` (default `15000`).
- Unwrap the envelope: return `body.data`. Keep the full envelope reachable on errors.
- Skip `undefined` query values. Path segments interpolated from user input must go through
  `encodeURIComponent` (license keys contain dashes and arrive from end users).
- **Retry**: only on `429` and `5xx`, only for `GET` and for `POST` calls that explicitly opt
  in via `{ retry: true }`. Default `retries: 2`. Wait `Retry-After` seconds when present,
  otherwise full-jitter exponential backoff starting at 300ms. `POST /checkout` must never be
  retried — a retried checkout is a duplicate sale.
- Map status → error class per the table above; anything else → `E_CHARIOW_REQUEST`.
- A non-JSON or unparseable body must raise `E_CHARIOW_REQUEST`, never crash on `JSON.parse`.
- `config.fetch` overrides the global `fetch` (this is the seam tests use — there is no mock
  framework in this package).

## `src/types.ts`

Transcribe from `resources/openapi.json`. Exported names:

`Amount`, `Pagination`, `ChariowEnvelope<T>`, `Store`, `Product`, `ProductSimplified`,
`StoreSimplified`, `DiscountSimplified`, `CustomerSimplified`, `Customer`, `SaleSummary`,
`SaleDetail`, `License`, `Activation`, `Discount`, `Pulse`, `Affiliate`, `CheckoutPayload`,
`CheckoutResult`, `ListParams`, and the literal unions `LicenseStatus`, `ProductType`,
`PulseEvent`.

```ts
type PulseEvent =
  | 'successful.sale' | 'abandoned.sale' | 'failed.sale'
  | 'license.issued' | 'license.activated' | 'license.expired'
  | 'license.nearing_expiry' | 'license.revoked'
  | 'affiliate.joined'
```

Note the deliberate mismatch, and do not "fix" it: the **webhook** event names use dots
(`successful.sale`) while the **Pulse trigger** values returned by `GET /pulses` use
underscores (`successful_sale`). Type them separately: `PulseEvent` and `PulseTriggerValue`.

Nullable spec fields must be `| null`, not optional.

## `src/chariow.ts`

```ts
class Chariow {
  constructor(config: ResolvedChariowConfig)

  store:      { get(): Promise<Store> }

  products:   { list(params?): Promise<Page<Product>>
                get(idOrSlug: string): Promise<Product>
                all(params?): AsyncIterable<Product> }

  checkout:   { create(payload: CheckoutPayload, ctx?: HttpContext): Promise<CheckoutResult> }

  sales:      { list, get, all }        // SaleSummary in lists, SaleDetail from get()
  customers:  { list, get, all }
  discounts:  { list, get, all }

  licenses:   { list(params?), get(key), all(params?)
                check(key: string): Promise<LicenseCheck>
                activate(key: string, deviceIdentifier?: string): Promise<License>
                revoke(key: string): Promise<License>
                activations(key: string, params?): Promise<Page<Activation>> }

  affiliates: { get(code: string): Promise<Affiliate>
                invite(emails: string[]): Promise<AffiliateInvitation[]> }

  pulses:     { list(params?), get(id), verify(ctx), handle(ctx, handlers) }
}
```

`Page<T>` is `{ data: T[]; pagination: Pagination }`.

`all()` is an async generator that walks `next_cursor` until `has_more` is false, so a caller
writes `for await (const sale of chariow.sales.all()) { … }`. Guard against a server that
returns the same cursor twice — stop rather than loop forever.

### `checkout.create`

Passing the `HttpContext` is the whole ergonomic point:

```ts
const result = await chariow.checkout.create({
  product_id: 'prd_abc',
  email: 'buyer@example.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: { number: '97000000', country_code: '+229' },
}, ctx)

return response.redirect(result.payment.checkout_url!)
```

When `ctx` is given and the payload does not already set `customer_ip`, fill it from
`ctx.request.ip()`. The spec is explicit that this endpoint is called server-to-server, so
without it Chariow records your server's IP and resolves the buyer's country wrongly — which
matters, because the target market is Benin.

When `config.currency` is set and the payload omits `payment_currency`, fill it in.

### `licenses.check` — the paywall primitive

```ts
type LicenseCheck =
  | { valid: true;  license: License }
  | { valid: false; license: License | null
      reason: 'not_found' | 'revoked' | 'expired' | 'inactive' }
```

Rules, in order: a `404` from the API resolves to `{ valid: false, license: null,
reason: 'not_found' }` — it must **not** throw, because an end user typing a wrong key is a
normal path, not an exception. Then `status === 'revoked'` → `revoked`;
`is_expired === true` or `status === 'expired'` → `expired`; `is_active !== true` → `inactive`
(this covers `pending_activation`); otherwise valid. Any other HTTP failure still throws.

Cache successful lookups in memory for `config.licenseCacheTtl` ms (default `60_000`, `0`
disables). The API allows only 100 requests per minute, so validating on every request would
throttle a live app. `activate()` and `revoke()` invalidate the cached entry for that key.

## `src/pulses.ts`

### `verify(ctx): PulseDelivery`

```ts
type PulseDelivery = {
  event: PulseEvent
  pulseId: string | null
  deliveryId: string | null
  payload: any            // typed per-event at the handle() call site
  isTest: boolean         // true when deliveryId is absent
}
```

1. Read the raw body with `ctx.request.raw()`. AdonisJS' bodyparser stores it for
   `application/json` requests (it calls `request.updateRawBody()` on the JSON branch), so no
   bodyparser configuration is needed. **Never** hash `JSON.stringify(ctx.request.body())` —
   Chariow sends compact JSON with escaped forward slashes and `\uXXXX` escapes, so a
   re-serialised body produces a different digest.
2. Missing raw body → `E_CHARIOW_INVALID_SIGNATURE`.
3. Read `x-chariow-signature`. Missing, or not prefixed `sha256=` →
   `E_CHARIOW_INVALID_SIGNATURE`.
4. Resolve the secret: `config.pulseSecret` is either a string, or a
   `Record<pulseId, secret>` for apps running several Pulses against one endpoint — in that
   case look it up by the `x-pulse-id` header. No secret configured → `E_CHARIOW_INVALID_SIGNATURE`.
5. `expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')`.
   Compare with `crypto.timingSafeEqual` over `Buffer.from(...)`. **Check lengths first** —
   `timingSafeEqual` throws on unequal buffer sizes, and this must return false, not throw.
6. Parse the body and return the delivery.

### `handle(ctx, handlers)`

```ts
await chariow.pulses.handle(ctx, {
  'successful.sale': async (payload) => { /* grant access */ },
  'license.revoked': async (payload) => { /* revoke access */ },
})
```

- Verify first; an invalid signature throws `E_CHARIOW_INVALID_SIGNATURE` (401).
- De-duplicate on `deliveryId`: if already seen, respond `200` and skip the handler. Test
  events have no `deliveryId` — process them, do not reject them. Dedupe is an in-memory
  `Map` with a TTL of 6h (retries can land ~3h late) and a bounded size; it is not shared
  across processes. Set `dedupe: false` in the config to turn it off, or pass your own
  `{ seen(id): Promise<boolean>; remember(id): Promise<void> }` for Redis/database dedupe.
- `await` the matching handler, then respond `200 { received: true }`. Awaiting means a
  handler that throws produces a non-2xx and Chariow retries the delivery — that is the
  behaviour we want. Document in the README that slow work belongs in a queue job.
- A `'*'` key, if present, receives `(event, payload)` for any event without a specific
  handler. An event with no handler at all is a `200` no-op.
- Handler payload types are keyed off `PulseEvent` so `'successful.sale'` hands back a
  `{ event, sale, product, customer, affiliate, store }` shape. Model these from the payload
  example in https://chariow.dev/en/guides/pulses.md.

## `src/define_config.ts`

```ts
export function defineConfig(config: ChariowConfig): ChariowConfig

type ChariowConfig = {
  apiKey: string
  pulseSecret?: string | Record<string, string>
  baseUrl?: string            // default 'https://api.chariow.com/v1'
  timeout?: number            // default 15_000
  retries?: number            // default 2
  currency?: string           // default payment_currency for checkout, e.g. 'XOF'
  licenseCacheTtl?: number    // default 60_000
  dedupe?: false | PulseDedupeStore
  fetch?: typeof globalThis.fetch
}
```

Applying defaults produces `ResolvedChariowConfig`. Throw a clear error at boot when `apiKey`
is empty.

## Adonis wiring

`providers/chariow_provider.ts` — register `Chariow` as a singleton bound to the `'chariow'`
container key, reading `config.get('chariow')`. Declaration-merge `ContainerBindings` so
`app.container.make('chariow')` is typed.

`services/main.ts` — the standard AdonisJS lazy service proxy so
`import chariow from '@devalade/adonis-chariow/services/main'` works at import time.

`configure.ts` — via `codemods`: publish `stubs/config/chariow.stub` to `config/chariow.ts`,
publish the controller stub to `app/controllers/chariow_pulses_controller.ts`, register the
provider, register the command, and `defineEnvValidations` for `CHARIOW_API_KEY` (required)
and `CHARIOW_PULSE_SECRET` (optional).

`stubs/config/chariow.stub` defaults `currency` to `'XOF'`.

`commands/chariow_check.ts` — `node ace chariow:check`. Calls `GET /store` and prints the
store name plus the product count, so a user can confirm their key in one command. On
`E_CHARIOW_UNAUTHORIZED`, print a pointer to https://app.chariow.com/settings/api.

## Tests (`tests/*.spec.ts`, Japa)

Signature verification is the highest-risk piece; test it hardest.

1. **pulses.spec.ts**
   - A fixture body containing an escaped URL (`https:\/\/store.example.com`) and an accented
     character (`é`) verifies when hashed raw, and **fails** when hashed after
     `JSON.stringify(JSON.parse(raw))`. This test is what proves we read the raw body.
   - Missing header, wrong secret, `md5=` prefix, and a truncated signature each reject —
     and the truncated one must reject rather than throw.
   - Per-pulse secret map resolves by `x-pulse-id`.
   - Same `deliveryId` twice → handler runs once, both requests get `200`.
   - No `deliveryId` (dashboard test event) → handler runs, `isTest` is true.
   - `'*'` fallback receives events without a specific handler.
2. **client.spec.ts** (inject `config.fetch`)
   - `422` → `E_CHARIOW_VALIDATION` with the field errors intact.
   - `429` with `Retry-After: 0` on a GET → retried once, then succeeds.
   - `429` on `POST /checkout` → throws immediately, exactly one fetch call.
   - `401` → `E_CHARIOW_UNAUTHORIZED`; HTML/garbage body → `E_CHARIOW_REQUEST`, no crash.
   - `undefined` query values are omitted from the URL.
3. **licenses.spec.ts** — table-driven over `status` / `is_active` / `is_expired` producing
   each `reason`; `404` → `not_found` without throwing; a second `check()` inside the TTL
   issues no second fetch; `revoke()` invalidates the cache.
4. **pagination.spec.ts** — `all()` walks two pages then stops; a repeated cursor terminates.
5. **checkout.spec.ts** — `customer_ip` is taken from a stubbed ctx, an explicit
   `customer_ip` in the payload wins, and `config.currency` fills `payment_currency`.

Use `@adonisjs/core/factories/http` (`HttpContextFactory`) to build a context in tests, and
`request.updateRawBody(raw)` to set the raw body.

## README

Lead with a 60-second quickstart, in this order: install + `node ace configure`, env vars,
sell something (`checkout.create` with `ctx`), receive the sale (the Pulse controller), gate
the app (`licenses.check`). Then a reference section. Include a short note that the API key is
server-side only and that the Pulse secret is per-Pulse (`whsec_…`), found under
Automations → Pulses → Overview — it is **not** the API key.

## Definition of done

`npm run typecheck` and `npm test` both pass; no `any` in exported signatures except the
deliberately loose Pulse `payload`; no TODO comments left in shipped code.
