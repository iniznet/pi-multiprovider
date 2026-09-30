import { createProvider, normalizeContext, type Api, type Model, type Provider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  bearerTokenFromAuth,
  createHttpUsageProbe,
  detectUsageUrl,
  MultiProviderService,
  NoAccountAvailableError,
  parseUsagePayload,
  UsageProbeCache,
  USAGE_WINDOW_FALLBACK_MS,
  type AccountUsageSnapshot,
} from '../src/index.ts'

const now = 1_750_000_000_000

const okWindow = (over: Partial<AccountUsageSnapshot['windows'][number]> = {}) => ({
  key: 'rolling',
  label: '5h',
  usedPercent: 40,
  remainingPercent: 60,
  rateLimited: false,
  resetsAt: now + 3_600_000,
  ...over,
})

describe('parseUsagePayload', () => {
  it('parses the opencode usage payload (percent is used budget)', () => {
    const snapshot = parseUsagePayload({
      usage: {
        rolling: { status: 'ok', percent: 37, resetsAt: new Date(now + 5_400_000).toISOString() },
        weekly: { status: 'ok', percent: 5, resetsAt: now / 1000 },
        monthly: { status: 'rate-limited', percent: 98, resetsAt: now + 20 * 86_400_000 },
      },
    }, now)
    expect(snapshot.isLimited).toBe(true)
    expect(snapshot.windows).toHaveLength(3)
    const [rolling, weekly, monthly] = snapshot.windows
    expect(rolling).toMatchObject({ key: 'rolling', label: '5h', usedPercent: 37, remainingPercent: 63, rateLimited: false })
    expect(weekly).toMatchObject({ key: 'weekly', label: '7d', usedPercent: 5, rateLimited: false, resetsAt: now })
    // Rate-limited windows are forced to 100% used regardless of the raw percent.
    expect(monthly).toMatchObject({ key: 'monthly', label: '30d', usedPercent: 100, remainingPercent: 0, rateLimited: true })
  })

  it('treats fully spent windows as limited and skips windows without data', () => {
    const snapshot = parseUsagePayload({
      usage: {
        rolling: { status: 'ok', percent: 100, resetsAt: null },
        weekly: { status: 'ok' },
        junk: 'not-an-object',
      },
    }, now)
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]).toMatchObject({ key: 'rolling', rateLimited: true, resetsAt: null })
    expect(snapshot.isLimited).toBe(true)
  })

  it('handles malformed payloads', () => {
    expect(parseUsagePayload(undefined, now)).toEqual({ fetchedAt: now, isLimited: false, windows: [] })
    expect(parseUsagePayload({ usage: 'nope' }, now).windows).toEqual([])
  })
})

describe('detectUsageUrl', () => {
  it('detects opencode zen usage endpoints', () => {
    expect(detectUsageUrl('https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(detectUsageUrl('https://opencode.ai/zen/go/v1/')).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(detectUsageUrl('https://opencode.ai/zen/go/v2')).toBe('https://opencode.ai/zen/go/v2/usage')
  })

  it('leaves unknown providers unprobed', () => {
    expect(detectUsageUrl('https://api.openai.com/v1')).toBeUndefined()
    expect(detectUsageUrl('https://opencode.ai/other/v1')).toBeUndefined()
    expect(detectUsageUrl('not-a-url')).toBeUndefined()
    expect(detectUsageUrl(undefined)).toBeUndefined()
  })
})

describe('createHttpUsageProbe', () => {
  it('sends the bearer token and parses the payload', async () => {
    let captured: { authorization?: string | undefined; url: string } | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      captured = {
        url: String(input),
        authorization: init?.headers?.authorization,
      }
      return new Response(JSON.stringify({ usage: { rolling: { status: 'ok', percent: 10, resetsAt: now } } }), { status: 200 })
    }) as typeof fetch
    try {
      const snapshot = await createHttpUsageProbe('https://opencode.ai/zen/go/v1/usage')('key-1', new AbortController().signal)
      expect(captured).toMatchObject({ url: 'https://opencode.ai/zen/go/v1/usage', authorization: 'Bearer key-1' })
      expect(snapshot.windows[0]).toMatchObject({ usedPercent: 10, rateLimited: false })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws on non-2xx so the cache can back off', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof fetch
    try {
      await expect(createHttpUsageProbe('https://opencode.ai/zen/go/v1/usage')('key', new AbortController().signal))
        .rejects.toThrow(/HTTP 403/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('bearerTokenFromAuth', () => {
  it('prefers the resolved api key', () => {
    expect(bearerTokenFromAuth({ auth: { apiKey: 'key-1' } })).toBe('key-1')
  })

  it('falls back to an Authorization header for OAuth credentials', () => {
    expect(bearerTokenFromAuth({ auth: { headers: { authorization: 'Bearer oauth-token' } } })).toBe('oauth-token')
    expect(bearerTokenFromAuth({ auth: { headers: { authorization: 'Basic xyz' } } })).toBeUndefined()
    expect(bearerTokenFromAuth({ auth: {} })).toBeUndefined()
  })
})

describe('UsageProbeCache', () => {
  const snapshotAt = (fetchedAt: number, isLimited = false): AccountUsageSnapshot => ({
    fetchedAt,
    isLimited,
    windows: [okWindow({ rateLimited: isLimited, usedPercent: isLimited ? 100 : 40, remainingPercent: isLimited ? 0 : 60 })],
  })

  it('serves fresh snapshots from the TTL cache', async () => {
    let calls = 0
    let currentTime = now
    const cache = new UsageProbeCache({ ttlMs: 60_000, errorBackoffMs: 300_000, now: () => currentTime })
    const probe = async () => {
      calls += 1
      return snapshotAt(currentTime)
    }
    const first = await cache.refresh('prov', 'acct', probe, 'token')
    const second = await cache.refresh('prov', 'acct', probe, 'token')
    expect(calls).toBe(1)
    expect(second).toBe(first)
    currentTime += 61_000
    await cache.refresh('prov', 'acct', probe, 'token')
    expect(calls).toBe(2)
  })

  it('force refresh bypasses the TTL', async () => {
    let calls = 0
    const cache = new UsageProbeCache({ now: () => now })
    const probe = async () => {
      calls += 1
      return snapshotAt(now)
    }
    await cache.refresh('prov', 'acct', probe, 'token')
    await cache.refresh('prov', 'acct', probe, 'token', true)
    expect(calls).toBe(2)
  })

  it('shares one in-flight probe across concurrent callers', async () => {
    let calls = 0
    const cache = new UsageProbeCache({ now: () => now })
    const probe = async () => {
      calls += 1
      await new Promise(resolve => { setTimeout(resolve, 5) })
      return snapshotAt(now)
    }
    const [a, b] = await Promise.all([
      cache.refresh('prov', 'acct', probe, 'token'),
      cache.refresh('prov', 'acct', probe, 'token'),
    ])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it('backs off after probe failures but keeps the last snapshot', async () => {
    let currentTime = now
    const cache = new UsageProbeCache({ ttlMs: 1, errorBackoffMs: 300_000, now: () => currentTime })
    const good = async (): Promise<AccountUsageSnapshot> => snapshotAt(now)
    const bad = async (): Promise<AccountUsageSnapshot> => {
      throw new Error('down')
    }
    const cached = await cache.refresh('prov', 'acct', good, 'token')
    await expect(cache.refresh('prov', 'acct', bad, 'token')).resolves.toBe(cached)
    // Inside the backoff window the failing probe is not retried.
    await expect(cache.refresh('prov', 'acct', bad, 'token', true)).resolves.toBe(cached)
    expect(cache.get('prov', 'acct')).toEqual(cached)
    currentTime += 301_000
    await expect(cache.refresh('prov', 'acct', good, 'token', true)).resolves.toMatchObject({ fetchedAt: now })
  })

  it('exposes snapshots for status surfaces', async () => {
    const cache = new UsageProbeCache({ now: () => now })
    const probe = async (): Promise<AccountUsageSnapshot> => snapshotAt(now)
    await cache.refresh('prov', 'a', probe, 't')
    await cache.refresh('prov', 'b', probe, 't')
    expect(cache.snapshots('prov').map(item => item.accountId)).toEqual(['a', 'b'])
    expect(cache.snapshots('other')).toEqual([])
  })
})

describe('probe-driven account blocking', () => {
  it('holds a cooled account out of selection until the reported reset', async () => {
    const model: Model<'test-api'> = {
      id: 'm',
      name: 'M',
      api: 'test-api',
      provider: 'prov',
      baseUrl: 'https://x.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    }
    const service = new MultiProviderService({ randomInt: () => 0 })
    const registration = {
      id: 'prov',
      label: 'Prov',
      accounts: () => [{ id: 'a', label: 'A', authKind: 'api-key' as const, credentialRef: 'a' }],
    }
    service.registerProvider(registration)
    const resetAt = Date.now() + 2 * 3_600_000
    service.coolAccountUntil('prov', 'a', resetAt)
    await expect(service.acquire({ providerId: 'prov' })).rejects.toBeInstanceOf(NoAccountAvailableError)
    // An earlier cooldown attempt does not shorten the block.
    service.coolAccountUntil('prov', 'a', Date.now() + 60_000)
    await expect(service.acquire({ providerId: 'prov' })).rejects.toBeInstanceOf(NoAccountAvailableError)
    void model
  })

  it('documents the fallback window math', () => {
    expect(USAGE_WINDOW_FALLBACK_MS.rolling).toBe(5 * 3_600_000)
    expect(USAGE_WINDOW_FALLBACK_MS.weekly).toBe(7 * 86_400_000)
    expect(USAGE_WINDOW_FALLBACK_MS.monthly).toBe(30 * 86_400_000)
  })
})

describe('probe capability gating', () => {
  it('uses a typed provider/model pair the extension can probe with', () => {
    const provider: Provider<Api> = createProvider<'test-api'>({
      id: 'opencode-go',
      name: 'OpenCode Go',
      auth: { apiKey: { name: 'key', async resolve() { return undefined } } },
      models: [],
      api: { stream() { throw new Error('unused') }, streamSimple() { throw new Error('unused') } },
    })
    expect(provider.getModels()).toEqual([])
    expect(normalizeContext({ messages: [] })).toBeDefined()
  })
})
