import { describe, expect, it } from 'vitest'
import {
  computeResetAt,
  describeBillingPolicy,
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

  it('honors the configured daily reset hour', () => {
    // 15:30 with a 09:00 reset: today's 09:00 has passed -> tomorrow 09:00.
    expect(computeResetAt({ kind: 'daily', hour: 9 }, sunday))
      .toBe(new Date(2025, 5, 16, 9, 0, 0).getTime())
    // 15:30 with an 18:00 reset: today's 18:00 is still ahead -> today 18:00.
    expect(computeResetAt({ kind: 'daily', hour: 18 }, sunday))
      .toBe(new Date(2025, 5, 15, 18, 0, 0).getTime())
  })

  it('honors the configured weekly reset hour', () => {
    // Sunday 15:30, hour 6 -> next Monday 06:00.
    expect(computeResetAt({ kind: 'weekly', hour: 6 }, sunday))
      .toBe(new Date(2025, 5, 16, 6, 0, 0).getTime())
    // Monday 05:00 with hour 6: today is Monday and 06:00 is still ahead.
    const mondayMorning = new Date(2025, 5, 16, 5, 0, 0).getTime()
    expect(computeResetAt({ kind: 'weekly', hour: 6 }, mondayMorning))
      .toBe(new Date(2025, 5, 16, 6, 0, 0).getTime())
  })

  it('honors the configured monthly reset hour', () => {
    // June 15 15:30, hour 4 -> July 1 04:00.
    expect(computeResetAt({ kind: 'monthly', hour: 4 }, sunday))
      .toBe(new Date(2025, 6, 1, 4, 0, 0).getTime())
    // On the 1st at 02:00 with a 04:00 reset: still today.
    const firstEarly = new Date(2025, 6, 1, 2, 0, 0).getTime()
    expect(computeResetAt({ kind: 'monthly', hour: 4 }, firstEarly))
      .toBe(new Date(2025, 6, 1, 4, 0, 0).getTime())
  })

  it('renders the reset hour in the billing label only when configured', () => {
    expect(describeBillingPolicy({ kind: 'daily' })).toBe('daily')
    expect(describeBillingPolicy({ kind: 'daily', hour: 9 })).toBe('daily @ 09:00')
    expect(describeBillingPolicy({ kind: 'weekly', hour: 0 })).toBe('weekly @ 00:00')
    expect(describeBillingPolicy({ kind: 'hours', hours: 5 })).toBe('5h window')
  })
})

describe('normalizeBillingPolicy', () => {
  it('accepts valid policies and defaults omitted hours for fixed windows', () => {
    expect(normalizeBillingPolicy({ kind: 'daily' })).toEqual({ kind: 'daily' })
    expect(normalizeBillingPolicy({ kind: 'hours', hours: 5 })).toEqual({ kind: 'hours', hours: 5 })
    expect(normalizeBillingPolicy({ kind: 'daily', hour: 9 })).toEqual({ kind: 'daily', hour: 9 })
    expect(normalizeBillingPolicy({ kind: 'weekly', hour: 0 })).toEqual({ kind: 'weekly', hour: 0 })
    // The rolling window has no reset hour; a stray one is dropped, not fatal.
    expect(normalizeBillingPolicy({ kind: 'hours', hours: 5, hour: 9 }))
      .toEqual({ kind: 'hours', hours: 5 })
  })

  it('rejects malformed reset hours', () => {
    expect(() => normalizeBillingPolicy({ kind: 'daily', hour: 24 })).toThrow()
    expect(() => normalizeBillingPolicy({ kind: 'monthly', hour: -1 })).toThrow()
    expect(() => normalizeBillingPolicy({ kind: 'weekly', hour: 7.5 })).toThrow()
    expect(() => normalizeBillingPolicy({ kind: 'daily', hour: '9' })).toThrow()
  })

  it('rejects malformed policies', () => {
    expect(() => normalizeBillingPolicy({ kind: 'forever' })).toThrow()
    expect(() => normalizeBillingPolicy({ kind: 'hours', hours: 0 })).toThrow()
    expect(() => normalizeBillingPolicy('daily')).toThrow()
    expect(normalizeBillingPolicy(undefined)).toBeUndefined()
  })
})
