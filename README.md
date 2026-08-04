# @devalade/adonis-chariow

Sell through [Chariow](https://chariow.com) from an AdonisJS app: start a checkout, receive
signed webhooks, gate your SaaS on a license key.

Built for AdonisJS 7. No runtime dependencies.

## Install

```sh
npm i @devalade/adonis-chariow
node ace configure @devalade/adonis-chariow
```

`configure` writes `config/chariow.ts`, adds a `ChariowPulsesController`, registers the
provider and the `chariow:check` command, and declares the env variables.

```dotenv
CHARIOW_API_KEY=sk_live_...
CHARIOW_PULSE_SECRET=whsec_...
```

Get the API key at [app.chariow.com/settings/api](https://app.chariow.com/settings/api). Then
confirm it works:

```sh
node ace chariow:check
# ✔ Connected to "Ma Boutique" (str_xyz789)
```

> The API key is server-side only. Never ship it to a browser or a mobile app.

## Sell something

```ts
import chariow from '@devalade/adonis-chariow/services/main'

export default class CheckoutController {
  async store(ctx: HttpContext) {
    const result = await chariow.checkout.create(
      {
        product_id: 'prd_abc',
        email: ctx.request.input('email'),
        first_name: ctx.request.input('first_name'),
        last_name: ctx.request.input('last_name'),
        phone: { number: '97000000', country_code: '+229' },
      },
      ctx // ← forwards the buyer's IP
    )

    return ctx.response.redirect(result.payment.checkout_url!)
  }
}
```

Passing the `HttpContext` fills `customer_ip` from `ctx.request.ip()`. This endpoint is called
server to server, so without it Chariow records **your server's** IP and resolves the buyer's
country wrongly. `payment_currency` is filled from `config.currency` when you omit it.

## Receive the sale

Point a Pulse at your app (Automations → Pulses → Add Pulse), then:

```ts
// start/routes.ts
router.post('/webhooks/chariow', [ChariowPulsesController])
```

```ts
// app/controllers/chariow_pulses_controller.ts
export default class ChariowPulsesController {
  async handle(ctx: HttpContext) {
    await chariow.pulses.handle(ctx, {
      'successful.sale': async (payload) => {
        await User.grantAccess(payload.customer.email, payload.product.id)
      },
      'license.revoked': async (payload) => {
        await User.revokeAccess(payload.license.id)
      },
    })
  }
}
```

`handle` verifies the HMAC signature over the raw body, skips deliveries it has already seen,
runs your handler and answers `200`. An unverified request throws
`E_CHARIOW_INVALID_SIGNATURE`, which AdonisJS turns into a `401`.

Two things to know:

- **The signing secret is not your API key.** Each Pulse has its own `whsec_…` value, under
  Automations → Pulses → your Pulse → Overview. Nothing else will ever produce a matching
  digest.
- **Handlers are awaited.** A handler that throws returns a non-2xx, and Chariow retries the
  delivery — which is what you want. Push slow work onto a queue rather than doing it inline.

If you use `@adonisjs/shield`, add the webhook path to `exceptRoutes` in `config/shield.ts` so
CSRF protection does not block it.

### Events

`successful.sale`, `abandoned.sale`, `failed.sale`, `license.issued`, `license.activated`,
`license.expired`, `license.nearing_expiry`, `license.revoked`, `affiliate.joined`.

Add `'*': (event, payload) => …` to catch everything you have not handled explicitly.

### Duplicate deliveries

Retries carry the same `x-pulse-delivery-id`, and the package remembers ids in memory for six
hours so a handler runs once. Running several processes? Share the state:

```ts
defineConfig({
  dedupe: {
    seen: (id) => redis.exists(`pulse:${id}`).then(Boolean),
    remember: async (id) => void redis.setex(`pulse:${id}`, 21_600, '1'),
  },
})
```

Set `dedupe: false` to turn it off.

## Gate your app on a license

```ts
const check = await chariow.licenses.check(licenseKey)

if (!check.valid) {
  // 'not_found' | 'revoked' | 'expired' | 'inactive'
  return response.forbidden({ reason: check.reason })
}

return check.license.expires_at
```

`check()` never throws for a key that does not exist — a customer mistyping their key is a
normal path, not an exception. Results are cached for 60s (`licenseCacheTtl`), because the API
allows only 100 requests per minute and you do not want to spend that budget on one user
refreshing a page.

Device-limited licenses:

```ts
await chariow.licenses.activate(licenseKey, deviceId)
await chariow.licenses.activations(licenseKey)
await chariow.licenses.revoke(licenseKey) // permanent
```

## Everything else

```ts
await chariow.store.get()

await chariow.products.list({ per_page: 20, type: 'license' })
await chariow.products.get('my-course') // id or slug

await chariow.sales.list({ status: 'completed' })
await chariow.sales.get('sal_xyz')

await chariow.customers.list({ search: 'ada@' })
await chariow.discounts.list({ status: 'active' })
await chariow.pulses.list()

await chariow.affiliates.get('ADA10')
await chariow.affiliates.invite(['friend@example.com'])
```

Every listing is cursor-paginated. `list()` gives you one page; `all()` walks them all:

```ts
for await (const sale of chariow.sales.all({ status: 'completed' })) {
  console.log(sale.amount.formatted)
}
```

Payload and response keys match the [Chariow API docs](https://chariow.dev) exactly, so you
can copy an example straight out of the docs and it type-checks.

## Errors

| Class | Code | Status |
|---|---|---|
| `ChariowUnauthorizedError` | `E_CHARIOW_UNAUTHORIZED` | 401 |
| `ChariowNotFoundError` | `E_CHARIOW_NOT_FOUND` | 404 |
| `ChariowValidationError` | `E_CHARIOW_VALIDATION` | 422 — has `.errors` |
| `ChariowRateLimitError` | `E_CHARIOW_RATE_LIMIT` | 429 — has `.retryAfter` |
| `ChariowInvalidSignatureError` | `E_CHARIOW_INVALID_SIGNATURE` | 401 |
| `ChariowRequestError` | `E_CHARIOW_REQUEST` | 500 — base class |

Each message starts with Chariow's own, so the cause is visible without unwrapping anything.
Reads retry twice on `429`/`5xx`, honouring `Retry-After`. **Checkout is never retried** — a
retried checkout is a duplicate sale.

## Configuration

```ts
defineConfig({
  apiKey: env.get('CHARIOW_API_KEY'),
  pulseSecret: env.get('CHARIOW_PULSE_SECRET'), // or { pulse_abc: 'whsec_…' } per Pulse
  currency: 'XOF',        // default payment_currency
  baseUrl: 'https://api.chariow.com/v1',
  timeout: 15_000,        // ms
  retries: 2,             // reads only
  licenseCacheTtl: 60_000, // ms, 0 disables
  dedupe: undefined,      // false, or your own store
  fetch: undefined,       // override for tests
})
```

## Testing your integration

Pass `fetch` to stub the API, with no mock framework involved:

```ts
const chariow = new Chariow({
  apiKey: 'sk_live_test',
  fetch: async () => Response.json({ message: 'ok', data: license, errors: [] }),
})
```

To test your own Pulse controller, sign a body the way Chariow does:

```ts
const raw = JSON.stringify({ event: 'successful.sale', sale: { id: 'sal_1' } })
const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
```

## License

MIT
