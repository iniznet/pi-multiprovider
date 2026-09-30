import { BILLING_RESET_KINDS, type BillingPolicy } from './types.ts'

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
  const now_ = new Date(now)
  if (policy.kind === 'daily') {
    return new Date(now_.getFullYear(), now_.getMonth(), now_.getDate() + 1).getTime()
  }
  if (policy.kind === 'weekly') {
    const daysUntilMonday = ((8 - now_.getDay()) % 7) || 7
    return new Date(now_.getFullYear(), now_.getMonth(), now_.getDate() + daysUntilMonday).getTime()
  }
  return new Date(now_.getFullYear(), now_.getMonth() + 1, 1).getTime()
}

export function describeBillingPolicy(policy: BillingPolicy): string {
  if (policy.kind === 'hours') return policy.hours + 'h window'
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
  return { kind: candidate.kind }
}

export function normalizeProviderQuotaEntry(value: unknown): { billing?: BillingPolicy; blockedUntil?: number; reason?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed provider quota entry')
  }
  const candidate = value as { billing?: unknown; blockedUntil?: unknown; reason?: unknown }
  const billing = normalizeBillingPolicy(candidate.billing)
  if (candidate.blockedUntil !== undefined
    && (typeof candidate.blockedUntil !== 'number' || !Number.isFinite(candidate.blockedUntil))) {
    throw new Error('multiprovider: malformed provider quota blockedUntil')
  }
  if (candidate.reason !== undefined && typeof candidate.reason !== 'string') {
    throw new Error('multiprovider: malformed provider quota reason')
  }
  return {
    ...(billing === undefined ? {} : { billing }),
    ...(candidate.blockedUntil === undefined ? {} : { blockedUntil: candidate.blockedUntil }),
    ...(typeof candidate.reason === 'string' && candidate.reason !== '' ? { reason: candidate.reason } : {}),
  }
}
