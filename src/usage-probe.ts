import type { AuthResult } from '@earendil-works/pi-ai'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const PROBE_TIMEOUT_MS = 10_000

// A single meter window as published by a provider's usage endpoint.
export interface UsageWindow {
  key: string
  /** Short human label: 5h / 7d / 30d (provider-specific keys pass through). */
  label: string
  /** 0-100, share of the window budget already consumed. */
  usedPercent: number
  /** 0-100, share of the window budget still available. */
  remainingPercent: number
  /** The provider is rejecting requests for this window (or it is fully spent). */
  rateLimited: boolean
  /** Window rollover instant in epoch milliseconds, null when unreported. */
  resetsAt: number | null
}

export interface AccountUsageSnapshot {
  fetchedAt: number
  isLimited: boolean
  windows: UsageWindow[]
}

export type UsageProbe = (token: string, signal: AbortSignal) => Promise<AccountUsageSnapshot>

// Fallback block duration per window key when the API does not report
// resetsAt: the oldest usage in a full window has aged out by then, so the
// account is conservatively held out for exactly one window length.
export const USAGE_WINDOW_FALLBACK_MS: Record<string, number> = {
  rolling: 5 * HOUR_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
}

const USAGE_WINDOW_LABELS: Record<string, string> = {
  rolling: '5h',
  weekly: '7d',
  monthly: '30d',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Accept ISO-8601 strings, epoch seconds, or epoch milliseconds.
export function parseResetsAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim()
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseResetsAt(Number(trimmed))
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// Published usage payload shape (opencode Go plan, GET {baseUrl}/usage):
//   { "usage": { "rolling" | "weekly" | "monthly":
//       { "status": "ok" | "rate-limited", "percent": 0-100, "resetsAt": ISO } } }
// `percent` is the share of the window budget already spent; windows without
// a percent and not rate-limited carry no usable signal and are skipped.
export function parseUsagePayload(payload: unknown, fetchedAt: number): AccountUsageSnapshot {
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : undefined
  const windows: UsageWindow[] = []
  if (usage !== undefined) {
    for (const [key, raw] of Object.entries(usage)) {
      if (!isRecord(raw)) continue
      const rateLimited = raw.status === 'rate-limited'
      const usedRaw = typeof raw.percent === 'number' && Number.isFinite(raw.percent)
        ? Math.min(100, Math.max(0, raw.percent))
        : undefined
      if (usedRaw === undefined && !rateLimited) continue
      const usedPercent = rateLimited ? 100 : usedRaw!
      windows.push({
        key,
        label: USAGE_WINDOW_LABELS[key] ?? key,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        rateLimited: rateLimited || usedPercent >= 100,
        resetsAt: parseResetsAt(raw.resetsAt),
      })
    }
  }
  return {
    fetchedAt,
    isLimited: windows.some(window => window.rateLimited),
    windows,
  }
}

// Providers known to publish the payload shape above: opencode's Go plan
// mounts the meters next to the completions API (GET {baseUrl}/usage).
export function detectUsageUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || !/^https?:\/\//i.test(baseUrl)) return undefined
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /^https:\/\/opencode\.ai\/zen\/go\/v\d+$/.test(trimmed)
    ? trimmed + '/usage'
    : undefined
}

export function createHttpUsageProbe(url: string): UsageProbe {
  return async (token, signal) => {
    const response = await fetch(url, {
      headers: { authorization: 'Bearer ' + token, 'user-agent': 'pi-multiprovider' },
      signal,
    })
    if (!response.ok) {
      throw new Error('usage probe ' + url + ' failed with HTTP ' + response.status)
    }
    return parseUsagePayload(await response.json(), Date.now())
  }
}

// The probe authenticates exactly like a request on the same account: the
// resolved API key, or the Authorization header an OAuth credential produced.
export function bearerTokenFromAuth(resolution: AuthResult): string | undefined {
  const apiKey = resolution.auth.apiKey
  if (apiKey !== undefined && apiKey !== '') return apiKey
  const authorization = Object.entries(resolution.auth.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  return authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
}

interface CacheEntry {
  snapshot?: AccountUsageSnapshot
  failedAt?: number
  failures?: number
  inFlight?: Promise<AccountUsageSnapshot | undefined>
}

// Per-account probe results with a freshness TTL so the periodic poll and the
// post-failure force refresh share one bounded cache instead of hammering the
// endpoint. Probe failures back off exponentially and never evict a still-
// recent snapshot: a stale reading stays better than no reading.
export class UsageProbeCache {
  private readonly entries = new Map<string, Map<string, CacheEntry>>()
  private readonly ttlMs: number
  private readonly errorBackoffMs: number
  private readonly maxErrorBackoffMs = 30 * 60_000
  private readonly now: () => number

  constructor(options: { ttlMs?: number; errorBackoffMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 60_000
    this.errorBackoffMs = options.errorBackoffMs ?? 300_000
    this.now = options.now ?? Date.now
  }

  get(providerId: string, accountId: string): AccountUsageSnapshot | undefined {
    return this.entries.get(providerId)?.get(accountId)?.snapshot
  }

  async refresh(
    providerId: string,
    accountId: string,
    probe: UsageProbe,
    token: string,
    force = false,
  ): Promise<AccountUsageSnapshot | undefined> {
    let accounts = this.entries.get(providerId)
    if (accounts === undefined) {
      accounts = new Map()
      this.entries.set(providerId, accounts)
    }
    let entry = accounts.get(accountId)
    if (entry === undefined) {
      entry = {}
      accounts.set(accountId, entry)
    }
    const now = this.now()
    if (!force && entry.snapshot !== undefined && now - entry.snapshot.fetchedAt < this.ttlMs) {
      return entry.snapshot
    }
    if (entry.failedAt !== undefined) {
      const backoff = Math.min(
        this.maxErrorBackoffMs,
        this.errorBackoffMs * 2 ** Math.min(5, entry.failures ?? 0),
      )
      if (now - entry.failedAt < backoff) return entry.snapshot
    }
    if (entry.inFlight !== undefined) return entry.inFlight
    const pending = entry
    pending.inFlight = (async () => {
      try {
        const snapshot = await probe(token, AbortSignal.timeout(PROBE_TIMEOUT_MS))
        pending.snapshot = snapshot
        delete pending.failedAt
        pending.failures = 0
        return snapshot
      } catch {
        pending.failedAt = this.now()
        pending.failures = (pending.failures ?? 0) + 1
        return pending.snapshot
      } finally {
        delete pending.inFlight
      }
    })()
    return pending.inFlight
  }

  // Flat view for status surfaces: (accountId, snapshot) pairs per provider.
  snapshots(providerId: string): { accountId: string; snapshot: AccountUsageSnapshot }[] {
    const accounts = this.entries.get(providerId)
    if (accounts === undefined) return []
    return [...accounts.entries()]
      .filter(([, entry]) => entry.snapshot !== undefined)
      .map(([accountId, entry]) => ({ accountId, snapshot: entry.snapshot! }))
  }
}
