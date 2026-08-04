import { test } from '@japa/runner'

import { decideSubscription, type SubscriptionStatus } from '../src/subscription.ts'
import type { License } from '../src/schemas.ts'
import { license } from './helpers.ts'

const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const OPTIONS = { renewalWindowDays: 7 }

/** A licence expiring `days` from NOW. Negative days are already past. */
function expiringIn(days: number, overrides: Partial<License> = {}): License {
  return license({ expires_at: new Date(NOW + days * DAY).toISOString(), ...overrides })
}

function decide(licenses: ReadonlyArray<License>, options = OPTIONS) {
  return decideSubscription(licenses, NOW, options)
}

test.group('subscription | status', () => {
  const cases: { title: string; license: License; status: SubscriptionStatus; active: boolean }[] = [
    {
      title: 'a lifetime licence',
      license: license({ expires_at: null }),
      status: 'active',
      active: true,
    },
    {
      title: 'a licence with a month left',
      license: expiringIn(30),
      status: 'active',
      active: true,
    },
    {
      title: 'a licence inside the renewal window',
      license: expiringIn(3),
      status: 'expiring',
      active: true,
    },
    {
      title: 'a licence expiring exactly on the window boundary',
      license: expiringIn(7),
      status: 'expiring',
      active: true,
    },
    {
      title: 'a licence just outside the window',
      license: expiringIn(8),
      status: 'active',
      active: true,
    },
    {
      title: 'an expired licence',
      license: expiringIn(-1, { status: 'expired', is_active: false, is_expired: true }),
      status: 'expired',
      active: false,
    },
    {
      title: 'a revoked licence',
      license: license({ status: 'revoked', is_active: false }),
      status: 'revoked',
      active: false,
    },
    {
      title: 'a licence awaiting activation',
      license: license({ status: 'pending_activation', is_active: false }),
      status: 'pending',
      active: false,
    },
  ]

  for (const testCase of cases) {
    test(`${testCase.title} reads as ${testCase.status}`, ({ assert }) => {
      const subscription = decide([testCase.license])

      assert.equal(subscription.status, testCase.status)
      assert.equal(subscription.isActive, testCase.active)
    })
  }

  test('no licences at all reads as none', ({ assert }) => {
    const subscription = decide([])

    assert.equal(subscription.status, 'none')
    assert.isFalse(subscription.isActive)
    assert.isNull(subscription.license)
    assert.isNull(subscription.expiresAt)
    assert.isFalse(subscription.renewalDue)
  })
})

test.group('subscription | renewal', () => {
  test('a lifetime licence never asks to be renewed', ({ assert }) => {
    const subscription = decide([license({ expires_at: null })])

    assert.isTrue(subscription.isLifetime)
    assert.isNull(subscription.daysRemaining)
    assert.isNull(subscription.expiresAt)
    assert.isFalse(subscription.renewalDue)
  })

  test('renewal is due inside the window and after expiry', ({ assert }) => {
    assert.isFalse(decide([expiringIn(30)]).renewalDue)
    assert.isTrue(decide([expiringIn(2)]).renewalDue)
    assert.isTrue(
      decide([expiringIn(-3, { status: 'expired', is_active: false, is_expired: true })]).renewalDue
    )
  })

  test('a revoked subscription is not renewable', ({ assert }) => {
    const subscription = decide([license({ status: 'revoked', is_active: false })])

    assert.equal(subscription.status, 'revoked')
    assert.isFalse(subscription.renewalDue)
  })

  test('a wider window catches a subscription an narrower one would miss', ({ assert }) => {
    assert.equal(decide([expiringIn(20)]).status, 'active')
    assert.equal(decide([expiringIn(20)], { renewalWindowDays: 30 }).status, 'expiring')
  })

  test('days remaining counts down and goes negative past expiry', ({ assert }) => {
    assert.equal(decide([expiringIn(30)]).daysRemaining, 30)
    assert.equal(decide([expiringIn(1)]).daysRemaining, 1)
    assert.equal(
      decide([expiringIn(-5, { status: 'expired', is_active: false, is_expired: true })])
        .daysRemaining,
      -5
    )
  })
})

test.group('subscription | choosing the governing licence', () => {
  test('a live licence beats an expired one, whatever the order', ({ assert }) => {
    const expired = expiringIn(-30, { status: 'expired', is_active: false, is_expired: true })
    const live = expiringIn(20)

    assert.equal(decide([expired, live]).status, 'active')
    assert.equal(decide([live, expired]).status, 'active')
  })

  test('the furthest expiry wins among live licences', ({ assert }) => {
    const soon = expiringIn(3)
    const later = expiringIn(90)

    const subscription = decide([soon, later])

    assert.equal(subscription.status, 'active')
    assert.equal(subscription.daysRemaining, 90)
  })

  test('a lifetime licence beats a dated one', ({ assert }) => {
    const subscription = decide([expiringIn(90), license({ expires_at: null })])

    assert.isTrue(subscription.isLifetime)
    assert.equal(subscription.status, 'active')
  })

  test('the newest is reported when none grant access', ({ assert }) => {
    const old = license({
      status: 'expired',
      is_active: false,
      is_expired: true,
      created_at: '2025-01-01T00:00:00.000Z',
    })
    const recent = license({
      status: 'revoked',
      is_active: false,
      created_at: '2026-05-01T00:00:00.000Z',
    })

    assert.equal(decide([old, recent]).status, 'revoked')
    assert.equal(decide([recent, old]).status, 'revoked')
  })

  test('carries the product the standing belongs to', ({ assert }) => {
    const subscription = decide([license({ product: { id: 'prd_pro', name: 'Pro', slug: 'pro' } })])

    assert.equal(subscription.productId, 'prd_pro')
  })
})
