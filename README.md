# @devalade/adonis-chariow

Sell through [Chariow](https://chariow.com) from an AdonisJS app: start a checkout, receive
signed webhooks, gate your SaaS on a license key, and run subscriptions on top of licences.

Built for AdonisJS 7. Two runtime dependencies: `zod` for parsing what Chariow sends back, and
`better-result` for typed failures.

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

> The API key is server-side only. Never ship it to a browser or a mobile app. Internally it is
> wrapped so it cannot reach a log line, a stack trace or `JSON.stringify` by accident.

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

    if (result.step === 'payment' && result.payment?.checkout_url) {
      return ctx.response.redirect(result.payment.checkout_url)
    }

    // A free product, or one this customer already owns.
    return ctx.response.redirect().toRoute('thank_you')
  }
}
```

`step` is `'payment'`, `'completed'` or `'already_purchased'` — a free product completes without
a payment URL, so branch rather than assuming one is there.

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

`handle` verifies the HMAC signature over the raw body, parses the payload, skips deliveries it
has already seen, runs your handler and answers `200`. An unverified request throws
`PulseSignatureInvalid`, which AdonisJS renders as a `401`; a body that is not a recognised Pulse
payload throws `PulsePayloadUnexpected` and renders as `400`.

`payload` is typed per event, and the fields Chariow documents on every delivery — `sale`,
`product`, `customer`, `store` — are non-optional, so there is nothing to guard against.

Three things to know:

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

## Subscriptions

Chariow has no subscription resource — renewing means buying again, which issues a *new* licence
rather than extending the old one. This derives the standing from the licences a customer holds,
so **your app stores no licence state**.

```ts
const sub = await chariow.subscriptions.forCustomer(user.chariowCustomerId, {
  product_id: 'prd_pro',
})

if (!sub.isActive) {
  return response.forbidden({ status: sub.status })
}

if (sub.renewalDue) {
  // still working, but expiring — nudge them
  await mail.send(new RenewalReminder(sub.daysRemaining))
}
```

| `status` | Access | Meaning |
|---|---|---|
| `none` | no | No licence for this product |
| `pending` | no | Issued, not yet activated |
| `active` | **yes** | Comfortably in date, or lifetime |
| `expiring` | **yes** | Works, but inside `renewalWindowDays` (default 7) |
| `expired` | no | Past `expires_at` |
| `revoked` | no | Revoked, and not renewable |

`isActive` is true for `active` and `expiring` — gate on that, not on `status === 'active'`, or
you will lock people out a week early. A lifetime licence (`expires_at: null`) is never
`expiring`, so its holder is never nagged to pay again.

### Looking it up

```ts
chariow.subscriptions.forCustomer(customerId, { product_id })  // 1 request — prefer this
chariow.subscriptions.forEmail(email, { product_id })          // 2 requests
chariow.subscriptions.forLicense(licenseKey)                   // 1 request
```

Store the Chariow `customer_id` against your user — every sale Pulse carries it as
`payload.customer.id` — and `forCustomer` costs one request instead of two. Omit `product_id` to
ask "does this person hold any subscription at all".

`forEmail` resolves the address through Chariow's customer search, which matches name *or* email,
so it only accepts an exact case-insensitive email match. A near miss reads as `none` rather than
handing someone another account's subscription.

Lookups are cached for `subscriptionCacheTtl` (default 60s) against the 100 requests/minute
budget. The *licences* are cached, not the decision, so `daysRemaining` keeps counting down
inside the window.

### Renewing

```ts
const result = await chariow.subscriptions.renew(sub, {
  first_name: user.firstName,
  last_name: user.lastName,
  phone: { number: user.phone, country_code: '+229' },
}, ctx)

return response.redirect(result.payment.checkout_url)
```

Product and email come from the subscription's licence; you supply what a licence does not carry.
The customer's full name is deliberately **not** split into first and last — that guess is wrong
too often to make quietly.

There is no automatic charging: Chariow has no stored-payment or recurring-charge API, so
renewal is always the customer going through checkout again.

### Lifecycle events

Point the same Pulse endpoint at business language instead of event names:

```ts
export default class ChariowPulsesController {
  async handle(ctx: HttpContext) {
    await chariow.subscriptions.handle(ctx, {
      onStarted:    async (sub) => access.grant(sub),      // license.issued
      onActivated:  async (sub) => access.grant(sub),      // license.activated
      onRenewalDue: async (sub) => mail.remind(sub),       // license.nearing_expiry
      onLapsed:     async (sub) => access.revoke(sub),     // license.expired
      onCancelled:  async (sub) => access.revoke(sub),     // license.revoked
    })
  }
}
```

The delivered payload already carries the whole licence, so `sub` arrives with `daysRemaining`
and `expiresAt` filled in — no extra API call. Signature verification, payload parsing and
delivery de-duplication are the same as `pulses.handle`, and sale events reaching the same
endpoint are answered `200` and ignored.

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

Every failure is a tagged class carrying `_tag`, `status`, `code` and safe structured fields.
The methods above throw them, and AdonisJS renders the status:

| Class | `_tag` | Status | Extra |
|---|---|---|---|
| `ChariowUnauthorized` | `ChariowUnauthorized` | 401 | `responseStatus` |
| `ChariowNotFound` | `ChariowNotFound` | 404 | |
| `ChariowValidationFailed` | `ChariowValidationFailed` | 422 | `errors` |
| `ChariowRateLimited` | `ChariowRateLimited` | 429 | `retryAfter` |
| `ChariowResponseUnexpected` | `ChariowResponseUnexpected` | 502 | `issues` |
| `ChariowRequestFailed` | `ChariowRequestFailed` | 500 | `responseStatus`, `cause` |
| `PulseSignatureInvalid` | `PulseSignatureInvalid` | 401 | `reason` |
| `PulsePayloadUnexpected` | `PulsePayloadUnexpected` | 400 | `issues` |

Each carries `operation`, so you know which call failed, and each message starts with Chariow's
own. Reads retry twice on `429`/`5xx`, honouring `Retry-After`. **Checkout is never retried** —
a retried checkout is a duplicate sale.

### Failures as values

`chariow.client` and `chariow.pulses.verify()` return `Result` from `better-result` instead of
throwing, for callers who would rather branch:

```ts
const result = await chariow.client.get('/store', { operation: 'getStore', schema: StoreSchema })

if (Result.isError(result)) {
  logger.warn({ operation: result.error.operation, tag: result.error._tag }, 'chariow down')
  return
}
```

### Responses are parsed, not trusted

Chariow's replies are parsed before you see them. A response missing a documented field raises
`ChariowResponseUnexpected` naming the field, rather than handing you an object whose types
promise more than it contains. Fields Chariow adds that this package does not model yet are
preserved, so an upgrade on their side does not silently drop data.

Failure `issues` name the field path and the type problem — never the received value, so you can
log them without leaking a customer's data.

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
  renewalWindowDays: 7,    // days before expiry that count as "expiring"
  subscriptionCacheTtl: 60_000, // ms, 0 disables
  dedupe: undefined,      // false, or your own store
  fetch: undefined,       // override for tests
  now: undefined,         // override the clock for tests
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

Pass `now` to drive the licence cache and the de-duplication window instead of waiting:

```ts
let clock = 1_000_000
const chariow = new Chariow({ apiKey, now: () => clock })
clock += 61_000 // the cached licence has now expired
```

To test your own Pulse controller, sign a body the way Chariow does:

```ts
const raw = JSON.stringify({ event: 'successful.sale', sale: { id: 'sal_1' }, /* … */ })
const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
```

## License

MIT
