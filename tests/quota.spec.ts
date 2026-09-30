import { describe, expect, it } from 'vitest'
import {
  computeResetAt,
  isFatalMetadataFailure,
  isQuotaFailure,
  normalizeBillingPolicy,
} from '../src/index.ts'

describe('isQuotaFailure', () => {
  it('classifies by status code', () => {
    expect(isQuotaFailure({ message: 'payment required', status: 402 })).toBe(true)
    expect(isQuotaFailure({ message: 'slow down', status: 429 })).toBe(true)
  })

  it('classifies by provider phrasing', () => {
    expect(isQuotaFailure({ message: '402: {"message":"You are out of credits. Add more at https://hyper.charm.land"}' })).toBe(true)
    expect(isQuotaFailure({ message: 'billing_error: insufficient balance' })).toBe(true)
    expect(isQuotaFailure({ message: 'usage limit reached for today' })).toBe(true)
    expect(isQuotaFailure({ message: 'unauthorized', status: 401 })).toBe(false)
    expect(isQuotaFailure({ message: 'internal error', status: 500 })).toBe(false)
  })
})

describe('isFatalMetadataFailure', () => {
  it('matches permanent metadata rejections', () => {
    expect(isFatalMetadataFailure({
      message: '400: {"message":"native reasoning control reasoning_effort is not allowed"}',
    })).toBe(true)
    expect(isFatalMetadataFailure({ message: '429: rate limited' })).toBe(false)
  })
})

describe('computeResetAt', () => {
  // 2025-06-15 is a Sunday; 15:30 local.
  const sunday = new Date(2025, 5, 15, 15, 30, 0).getTime()

  it('blocks until the next local midnight for daily billing', () => {
    const reset = computeResetAt({ kind: 'daily' }, sunday)
    expect(new Date(reset)).toEqual(new Date(2025, 5, 16, 0, 0, 0))
  })

  it('blocks until the next Monday 00:00 for weekly billing', () => {
    const reset = computeResetAt({ kind: 'weekly' }, sunday)
    // 2025-06-15 is a Sunday; the next Monday is June 16, 00:00 local.
    expect(new Date(reset)).toEqual(new Date(2025, 5, 16, 0, 0, 0))
  })

  it('blocks until the 1st of the next month for monthly billing', () => {
    const reset = computeResetAt({ kind: 'monthly' }, sunday)
    expect(new Date(reset)).toEqual(new Date(2025, 6, 1, 0, 0, 0))
  })

  it('blocks for the rolling window for hours billing', () => {
    expect(computeResetAt({ kind: 'hours', hours: 5 }, sunday)).toBe(sunday + 5 * 3_600_000)
    expect(computeResetAt({ kind: 'hours', hours: 1000 }, sunday)).toBe(sunday + 336 * 3_600_000)
  })
})

describe('normalizeBillingPolicy', () => {
  it('accepts valid policies and defaults omitted hours for fixed windows', () => {
    expect(normalizeBillingPolicy({ kind: 'daily' })).toEqual({ kind: 'daily' })
    expect(normalizeBillingPolicy({ kind: 'hours', hours: 5 })).toEqual({ kind: 'hours', hours: 5 })
  })

  it('rejects malformed policies', () => {
    expect(() => normalizeBillingPolicy({ kind: 'forever' })).toThrow()
    expect(() => normalizeBillingPolicy({ kind: 'hours', hours: 0 })).toThrow()
    expect(() => normalizeBillingPolicy('daily')).toThrow()
    expect(normalizeBillingPolicy(undefined)).toBeUndefined()
  })
})
