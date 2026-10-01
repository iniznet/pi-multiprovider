import { BILLING_RESET_KINDS, type BillingPolicy, type ProviderQuotaState } from './types.ts'

const HOUR_MS = 3_600_000

// Provider quota/billing exhaustion: 402 (payment required), 429 plus the
// phrasing providers use for spent balances and exhausted usage windows.
const QUOTA_MESSAGE_RE = /out of credits|billing|insufficient|quota|usage.?limit|limit (?:has been )?reached|reached .{0,32}limit|add more at|exceeded/i

// Permanent per-model rejections caused by wrong metadata (e.g. an upstream
// that rejects native reasoning control). These never recover by retrying.
const FATAL_METADATA_RE = /not allowed|unsupported|is not supported|invalid_request/i

export interface QuotaFailureProbe {
  message: string
  status?: number
}

export function isQuotaFailure(failure: QuotaFailureProbe): boolean {
  if (failure.status === 402 || failure.status === 429) return true
  return QUOTA_MESSAGE_RE.test(failure.message)
}

export function isFatalMetadataFailure(failure: { message: string }): boolean {
  return FATAL_METADATA_RE.test(failure.message)
}

// When a quota-blocked provider becomes usable again, according to the
// operator's billing marking. Boundaries use local time: daily blocks until
// the next midnight, weekly until the next Monday 00:00, monthly until the
// 1st of the next month, hours until now + the window length.
export function computeResetAt(policy: BillingPolicy, now: number): number {
  if (policy.kind === 'hours') {
    const hours = policy.hours ?? 1
    return now + Math.min(336, Math.max(1, hours)) * HOUR_MS
  }
  // Calendar resets honor the operator's local reset hour (0-23, default
  // midnight): the next boundary is today when the reset hour has not passed
  // yet. With the default hour 0 that is always tomorrow, matching the
  // previous fixed-midnight behavior.
  const hour = policy.hour ?? 0
  const now_ = new Date(now)
  if (policy.kind === 'daily') {
    const todayAtHour = new Date(now_.getFullYear(), now_.getMonth(), now_.getDate(), hour).getTime()
    return todayAtHour > now
      ? todayAtHour
      : new Date(now_.getFullYear(), now_.getMonth(), now_.getDate() + 1, hour).getTime()
  }
  if (policy.kind === 'weekly') {
    const daysAhead = (8 - now_.getDay()) % 7
    const candidate = new Date(
      now_.getFullYear(), now_.getMonth(), now_.getDate() + daysAhead, hour,
    ).getTime()
    return candidate > now
      ? candidate
      : new Date(now_.getFullYear(), now_.getMonth(), now_.getDate() + daysAhead + 7, hour).getTime()
  }
  const firstAtHour = new Date(now_.getFullYear(), now_.getMonth(), 1, hour).getTime()
  return firstAtHour > now
    ? firstAtHour
    : new Date(now_.getFullYear(), now_.getMonth() + 1, 1, hour).getTime()
}

export function describeBillingPolicy(policy: BillingPolicy): string {
  if (policy.kind === 'hours') return policy.hours + 'h window'
  if (policy.hour !== undefined) {
    return policy.kind + ' @ ' + String(policy.hour).padStart(2, '0') + ':00'
  }
  return policy.kind
}

export function normalizeBillingPolicy(value: unknown): BillingPolicy | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed billing policy')
  }
  const candidate = value as Partial<BillingPolicy>
  if (typeof candidate.kind !== 'string' || !(BILLING_RESET_KINDS as readonly string[]).includes(candidate.kind)) {
    throw new Error('multiprovider: malformed billing policy kind')
  }
  if (candidate.kind === 'hours') {
    const hours = candidate.hours
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 1 || hours > 336) {
      throw new Error('multiprovider: billing policy hours must be a number between 1 and 336')
    }
    return { kind: candidate.kind, hours: Math.floor(hours) }
  }
  if (candidate.hour !== undefined
    && (typeof candidate.hour !== 'number'
      || !Number.isInteger(candidate.hour)
      || candidate.hour < 0
      || candidate.hour > 23)) {
    throw new Error('multiprovider: billing policy hour must be an integer between 0 and 23')
  }
  return candidate.hour === undefined
    ? { kind: candidate.kind }
    : { kind: candidate.kind, hour: candidate.hour }
}

// One shape check per optional numeric field, so adding a field to a quota
// entry composes a check instead of growing the validator's branching.
function assertOptionalQuotaNumber(value: unknown, name: string): asserts value is number | undefined {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`multiprovider: malformed provider quota ${name}`)
  }
}

export function normalizeProviderQuotaEntry(value: unknown): ProviderQuotaState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed provider quota entry')
  }
  const candidate = value as {
    billing?: unknown
    blockedUntil?: unknown
    reason?: unknown
    maxConcurrent?: unknown
  }
  const billing = normalizeBillingPolicy(candidate.billing)
  assertOptionalQuotaNumber(candidate.blockedUntil, 'blockedUntil')
  if (candidate.reason !== undefined && typeof candidate.reason !== 'string') {
    throw new Error('multiprovider: malformed provider quota reason')
  }
  assertOptionalQuotaNumber(candidate.maxConcurrent, 'maxConcurrent')
  // A limit below one is the same as no limit: refusing it would bench the
  // provider outright.
  const maxConcurrent = typeof candidate.maxConcurrent === 'number' && candidate.maxConcurrent >= 1
    ? Math.floor(candidate.maxConcurrent)
    : undefined
  return {
    ...(billing === undefined ? {} : { billing }),
    ...(candidate.blockedUntil === undefined ? {} : { blockedUntil: candidate.blockedUntil }),
    ...(typeof candidate.reason === 'string' && candidate.reason !== '' ? { reason: candidate.reason } : {}),
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  }
}
