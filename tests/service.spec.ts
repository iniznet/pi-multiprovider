import { describe, expect, it } from 'vitest'
import {
  MultiProviderService,
  NoAccountAvailableError,
  type ProviderAccount,
  type ProviderAttemptFailure,
  SCHEDULER_DEFAULTS,
  type SelectionPolicy,
  UnknownAccountError,
} from '../src/index.ts'

const accounts: ProviderAccount<string>[] = [
  { id: 'a', label: 'Work', authKind: 'api-key', credentialRef: 'secret-work', weight: 3, priority: 1 },
  { id: 'b', label: 'Personal', authKind: 'oauth', credentialRef: 'secret-personal', weight: 1, priority: 2 },
]

function scheduler(options: ConstructorParameters<typeof MultiProviderService>[0] = {}) {
  const service = new MultiProviderService({
    randomId: (() => {
      let id = 0
      return () => `lease-${++id}`
    })(),
    ...options,
  })
  service.registerProvider({ id: 'example', label: 'Example', accounts: () => accounts })
  return service
}

async function select(
  service: MultiProviderService,
  options: { affinityKey?: string; excludeAccountIds?: string[] } = {},
): Promise<string> {
  const lease = await service.acquire<string>({ providerId: 'example', ...options })
  lease.release({ status: 'success' })
  return lease.accountId
}

function failure(status: number): ProviderAttemptFailure {
  return { message: `HTTP ${status}`, status, outputStarted: false }
}

describe('MultiProviderService', () => {
  it('absorbs a configurable number of errors before failing over', async () => {
    const service = new MultiProviderService()
    expect(service.getErrorsBeforeSwitch()).toBe(3)
    service.updateSchedulerDefaults({ errorsBeforeSwitch: 5 })
    expect(service.getErrorsBeforeSwitch()).toBe(5)
    service.updateSchedulerDefaults({ errorsBeforeSwitch: 0 })
    expect(service.getErrorsBeforeSwitch()).toBe(1)
  })

  it('keeps unpinned selection on the main account and never exposes credential references', async () => {
    const service = scheduler()
    expect(await select(service)).toBe('a')
    // First-account bias: unpinned picks stay on the first healthy account.
    expect(await select(service)).toBe('a')
    const lease = await service.acquire<string>({ providerId: 'example' })
    expect(lease.accountId).toBe('a')
    expect(lease.credentialRef).toBe('secret-work')
    lease.release()

    const snapshot = await service.snapshot()
    expect(snapshot.providers[0]?.firstAccountBias).toBe(true)
    expect(snapshot.providers[0]?.accounts).toHaveLength(2)
    expect(JSON.stringify(snapshot)).not.toContain('secret-work')
    expect(JSON.stringify(snapshot)).not.toContain('secret-personal')
  })

  it('serves concurrent fresh-session requests from the main account without splitting them', async () => {
    const service = scheduler()
    // Two requests starting in the same tick of one new session: first-account
    // bias sends both to the main account. No request fans out to a second
    // account, and no rotation cursor splits concurrent session starts.
    const [first, second] = await Promise.all([
      service.acquire<string>({ providerId: 'example', affinityKey: 'session-1' }),
      service.acquire<string>({ providerId: 'example', affinityKey: 'session-1' }),
    ])
    expect(first.accountId).toBe('a')
    expect(second.accountId).toBe('a')
    first.release({ status: 'success' })
    second.release({ status: 'success' })

    // Same guarantee with session affinity disabled: bias ignores the cursor.
    const serviceNoAffinity = scheduler({ affinity: false })
    const [third, fourth] = await Promise.all([
      serviceNoAffinity.acquire<string>({ providerId: 'example' }),
      serviceNoAffinity.acquire<string>({ providerId: 'example' }),
    ])
    expect(third.accountId).toBe('a')
    expect(fourth.accountId).toBe('a')
    third.release({ status: 'success' })
    fourth.release({ status: 'success' })
  })

  it('re-pins a spilled session to the account that served it', async () => {
    const service = scheduler()
    // Main account unavailable (cooling/excluded): the session spills to the
    // next account in pool order and then sticks to it for cache warmth.
    expect(await select(service, { affinityKey: 'session-1', excludeAccountIds: ['a'] })).toBe('b')
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    // A different session still starts on the recovered main account.
    expect(await select(service, { affinityKey: 'session-2' })).toBe('a')
  })

  it('spills unpinned selection over in pool order and follows pool order over id order', async () => {
    const service = scheduler()
    expect(await select(service, { excludeAccountIds: ['a'] })).toBe('b')
    const reversed = new MultiProviderService()
    reversed.registerProvider({
      id: 'example',
      label: 'Example',
      accounts: () => [...accounts].reverse(),
    })
    expect(await select(reversed)).toBe('b')
  })

  it('rotates evenly for providers registered without first-account bias', async () => {
    const service = new MultiProviderService({
      randomInt: () => 0,
      randomId: (() => {
        let id = 0
        return () => `lease-${++id}`
      })(),
    })
    service.registerProvider({
      id: 'example',
      label: 'Example',
      selectionBias: 'none',
      accounts: () => accounts.map(account => ({ ...account, weight: 1 })),
    })
    expect(await select(service)).toBe('a')
    expect(await select(service)).toBe('b')
    expect(await select(service)).toBe('a')
  })

  it('rotates unweighted pools in pool order starting at a random offset', async () => {
    const service = new MultiProviderService({ affinity: false, randomInt: () => 1 })
    service.registerProvider({
      id: 'example',
      label: 'Example',
      selectionBias: 'none',
      accounts: () => [
        { id: 'zeta', label: 'Zeta', authKind: 'api-key', credentialRef: 'z', weight: 1 },
        { id: 'alpha', label: 'Alpha', authKind: 'api-key', credentialRef: 'a', weight: 1 },
        { id: 'mid', label: 'Mid', authKind: 'api-key', credentialRef: 'm', weight: 1 },
      ],
    })
    // Offset 1 into pool order [zeta, alpha, mid], then plain rotation in
    // pool order — never id order.
    expect(await select(service)).toBe('alpha')
    expect(await select(service)).toBe('mid')
    expect(await select(service)).toBe('zeta')
  })

  it('honors differing weights under plain round-robin', async () => {
    const service = new MultiProviderService({ affinity: false, randomInt: () => 0 })
    service.registerProvider({
      id: 'example',
      label: 'Example',
      selectionBias: 'none',
      accounts: () => [
        { id: 'a', label: 'Heavy', authKind: 'api-key', credentialRef: 'a', weight: 3 },
        { id: 'b', label: 'Light', authKind: 'api-key', credentialRef: 'b', weight: 1 },
      ],
    })
    const picks: string[] = []
    for (let i = 0; i < 8; i++) picks.push(await select(service))
    expect(picks.filter(id => id === 'a')).toHaveLength(6)
    expect(picks.filter(id => id === 'b')).toHaveLength(2)
  })

  it('spills new sessions to the next account while the main account cools down', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now, affinity: false })
    const lease = await service.acquire({ providerId: 'example' })
    expect(lease.accountId).toBe('a')
    lease.release({ status: 'failure', error: failure(429) })
    expect(await select(service)).toBe('b')
    now = 61_000
    expect(await select(service)).toBe('a')
  })

  it('pins affinity while available and honors explicit attempt exclusions', async () => {
    const service = scheduler()
    const first = await select(service, { affinityKey: 'session-1' })
    expect(await select(service, { affinityKey: 'session-1' })).toBe(first)
    expect(await select(service, { affinityKey: 'session-1', excludeAccountIds: [first] })).not.toBe(first)
    await expect(service.acquire({
      providerId: 'example',
      excludeAccountIds: ['a', 'b'],
    })).rejects.toBeInstanceOf(NoAccountAvailableError)
  })

  it('tracks leases idempotently and cools down failed accounts', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now, rateLimitCooldownMs: 500 })
    const lease = await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })
    expect((await service.snapshot()).providers[0]?.accounts[0]?.inFlight).toBe(1)
    expect(lease.release({ status: 'failure', error: failure(429) })).toMatchObject({
      kind: 'rate-limit', retryable: true,
    })
    expect(lease.release({ status: 'success' })).toBeUndefined()

    const account = (await service.snapshot()).providers[0]?.accounts.find(item => item.id === 'a')
    expect(account).toMatchObject({
      status: 'cooldown', inFlight: 0, consecutiveFailures: 1, cooldownUntil: 1_500,
    })
    now = 1_500
    expect((await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })).accountId).toBe('a')
  })

  it('classifies HTTP status embedded in adapter error messages', async () => {
    const service = scheduler()
    const lease = await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })
    expect(lease.release({
      status: 'failure',
      error: {
        message: '401: authentication rejected before a response callback',
        outputStarted: false,
      },
    })).toMatchObject({ kind: 'auth', retryable: true })
    expect((await service.snapshot()).providers[0]?.accounts.find(account => account.id === 'a')).toMatchObject({
      status: 'cooldown', lastFailureKind: 'auth',
    })
  })

  it('supports smooth weighted and least-in-flight selection', async () => {
    const weighted = scheduler({ affinity: false, defaultPolicy: 'weighted-round-robin' })
    const selections = await Promise.all(Array.from({ length: 8 }, () => select(weighted)))
    expect(selections.filter(account => account === 'a')).toHaveLength(6)
    expect(selections.filter(account => account === 'b')).toHaveLength(2)

    const least = scheduler({ affinity: false, defaultPolicy: 'least-inflight' })
    const first = await least.acquire({ providerId: 'example' })
    const second = await least.acquire({ providerId: 'example' })
    expect(second.accountId).not.toBe(first.accountId)
    first.release()
    second.release()
  })

  it('applies operator policy and account preferences independently of health', async () => {
    const service = scheduler()
    await service.updatePool('example', {
      policy: 'priority',
      affinity: false,
      accounts: [
        { accountId: 'a', enabled: false, weight: 1, priority: 0 },
        { accountId: 'b', enabled: true, weight: 1, priority: -1 },
      ],
    })
    expect(await select(service)).toBe('b')
    expect(service.getPoolPreference('example')).toMatchObject({
      policy: 'priority', affinity: false,
    })
    service.resetHealth('example', 'a')
    expect((await service.snapshot()).providers[0]?.accounts.find(item => item.id === 'a')?.status).toBe('disabled')
  })

  it('updates scheduler cooldowns live via updateSchedulerDefaults', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now })
    service.updateSchedulerDefaults({ rateLimitCooldownMs: 250 })
    const lease = await service.acquire({ providerId: 'example', excludeAccountIds: ['b'] })
    expect(lease.release({ status: 'failure', error: failure(429) })).toMatchObject({
      kind: 'rate-limit',
      retryable: true,
    })
    const account = (await service.snapshot()).providers[0]?.accounts.find(item => item.id === 'a')
    expect(account?.cooldownUntil).toBe(1_250)
    expect(SCHEDULER_DEFAULTS.rateLimitCooldownMs).toBe(60_000)
    expect(() => service.updateSchedulerDefaults({ rateLimitCooldownMs: -1 })).toThrow('non-negative')
  })

  it('lists every session attached to a pool, implicit and explicit', async () => {
    const service = scheduler()
    await service.acquire({ providerId: 'example', affinityKey: 'session-1' })
    await service.acquire({ providerId: 'example', affinityKey: 'session-2' })
    await service.pinAccount('example', 'session-3', 'b')
    expect(service.affinityEntries('example')).toEqual([
      { key: 'session-1', accountId: 'a', explicit: false },
      { key: 'session-2', accountId: 'a', explicit: false },
      { key: 'session-3', accountId: 'b', explicit: true },
    ])
    // An acquire without a key is a probe, not a session: the early pick runs
    // the strategy through it and must leave no attachment behind.
    const probe = await service.acquire({ providerId: 'example' })
    probe.release()
    expect(service.affinityEntries('example')).toHaveLength(3)
    // Completion calls this speculatively mid-typing: unknown pools are empty,
    // not an exception.
    expect(service.affinityEntries('no-such-pool')).toEqual([])
  })

  it('pins an explicit session account that survives exclusions and cooldowns', async () => {
    let now = 1_000
    const service = scheduler({ now: () => now })
    await service.pinAccount('example', 'session-1', 'b')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: true })
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    // Retry exclusions within a logical request fall back without stealing the pin.
    expect(await select(service, { affinityKey: 'session-1', excludeAccountIds: ['b'] })).toBe('a')
    expect(service.getAffinity('example', 'session-1')?.accountId).toBe('b')
    // A cooldown falls back temporarily, then the session returns to the pin.
    const lease = await service.acquire({ providerId: 'example', affinityKey: 'session-1' })
    expect(lease.accountId).toBe('b')
    lease.release({ status: 'failure', error: failure(429) })
    now = 30_000
    expect(await select(service, { affinityKey: 'session-1' })).toBe('a')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: true })
    now = 61_000
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
  })

  it('honors explicit session pins even when pool affinity is off', async () => {
    const service = scheduler({ affinity: false })
    expect(service.getPoolPreference('example').affinity).toBe(false)
    expect(await select(service, { affinityKey: 'session-1' })).toBe('a')
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
    await service.pinAccount('example', 'session-1', 'b')
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    expect(service.getPoolPreference('example').affinity).toBe(false)
  })

  it('validates pin targets and drops pins for disabled accounts', async () => {
    const service = scheduler()
    await expect(service.pinAccount('example', 'session-1', 'missing'))
      .rejects.toBeInstanceOf(UnknownAccountError)
    await service.pinAccount('example', 'session-1', 'a')
    await service.updatePool('example', {
      accounts: [{ accountId: 'a', enabled: false, weight: 1, priority: 0 }],
    })
    await expect(service.pinAccount('example', 'session-1', 'a')).rejects.toThrow('disabled')
    expect(await select(service, { affinityKey: 'session-1' })).toBe('b')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: false })
  })

  it('clears explicit session pins on demand', async () => {
    const service = scheduler()
    await service.pinAccount('example', 'session-1', 'b')
    service.clearAffinity('example', 'session-1')
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
    expect(await select(service, { affinityKey: 'session-1' })).toBe('a')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'a', explicit: false })
    service.clearAffinity()
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
  })
})

interface GroupedBackend {
  id: string
  group: string
  weight?: number
  priority?: number
  maxConcurrent?: number
}

// Two providers, each exposing two of the same virtual model: the shape a
// /vprovider pool has when a backing provider caps concurrency per model.
const VIRTUAL_BACKENDS: GroupedBackend[] = [
  { id: 'p1::m1', group: 'p1' },
  { id: 'p1::m2', group: 'p1' },
  { id: 'p2::m1', group: 'p2' },
  { id: 'p2::m2', group: 'p2' },
]

async function groupedService(
  options: {
    backends?: GroupedBackend[]
    providerStrategy?: SelectionPolicy | null
    modelStrategy?: SelectionPolicy
  } = {},
): Promise<MultiProviderService> {
  const service = new MultiProviderService({ randomInt: () => 0 })
  service.registerProvider({
    id: 'virtual',
    label: 'Virtual',
    selectionBias: 'none',
    accounts: () => (options.backends ?? VIRTUAL_BACKENDS).map(backend => ({
      id: backend.id,
      label: backend.id,
      authKind: 'custom' as const,
      credentialRef: backend.id,
      group: backend.group,
      ...(backend.weight === undefined ? {} : { weight: backend.weight }),
      ...(backend.priority === undefined ? {} : { priority: backend.priority }),
      ...(backend.maxConcurrent === undefined ? {} : { maxConcurrent: backend.maxConcurrent }),
    })),
  })
  await service.updatePool('virtual', {
    affinity: false,
    policy: options.modelStrategy ?? 'round-robin',
    groupPolicy: options.providerStrategy === undefined ? 'round-robin' : options.providerStrategy,
  })
  return service
}

async function held(service: MultiProviderService, key?: string) {
  return service.acquire<string>({
    providerId: 'virtual',
    ...(key === undefined ? {} : { affinityKey: key }),
  })
}

async function picks(service: MultiProviderService, count: number): Promise<string[]> {
  const seen: string[] = []
  for (let index = 0; index < count; index += 1) {
    const lease = await held(service)
    seen.push(lease.accountId)
    lease.release({ status: 'success' })
  }
  return seen
}

describe('two-level selection', () => {
  it('rotates providers and models independently', async () => {
    const service = await groupedService()
    expect(await picks(service, 4)).toEqual(['p1::m1', 'p2::m1', 'p1::m2', 'p2::m2'])
    const pool = (await service.snapshot()).providers[0]!
    expect(pool.groupPolicy).toBe('round-robin')
    expect(pool.accounts.map(account => account.group)).toEqual(['p1', 'p1', 'p2', 'p2'])
  })

  it('stays on one flat pass until a provider strategy is chosen', async () => {
    const service = await groupedService({ providerStrategy: null })
    // Flat round robin walks inventory order, so one provider serves twice in a
    // row; the grouped path never repeats a provider before the other is used.
    expect(await picks(service, 4)).toEqual(['p1::m1', 'p1::m2', 'p2::m1', 'p2::m2'])
    expect((await service.snapshot()).providers[0]!.groupPolicy).toBeUndefined()
  })

  it('skips a provider whose models are all at their soft cap', async () => {
    const service = await groupedService({
      providerStrategy: 'priority',
      modelStrategy: 'priority',
      backends: [
        { id: 'p1::m1', group: 'p1', maxConcurrent: 1, priority: 0 },
        { id: 'p1::m2', group: 'p1', maxConcurrent: 1, priority: 0 },
        { id: 'p2::m1', group: 'p2', priority: 1 },
        { id: 'p2::m2', group: 'p2', priority: 1 },
      ],
    })
    // p1 is the preferred provider, so it fills model by model first.
    const first = await held(service)
    const second = await held(service)
    expect([first.accountId, second.accountId]).toEqual(['p1::m1', 'p1::m2'])
    // Every model on p1 is at its cap, so the provider as a whole is skipped
    // while the lower-priority provider still has headroom.
    const third = await held(service)
    expect(third.accountId.startsWith('p2::')).toBe(true)
    // Freeing one model brings the preferred provider back.
    first.release({ status: 'success' })
    const fourth = await held(service)
    expect(fourth.accountId).toBe('p1::m1')
    for (const lease of [second, third, fourth]) lease.release({ status: 'success' })
  })

  it('serves the least loaded backend when every cap is reached', async () => {
    const service = await groupedService({
      backends: VIRTUAL_BACKENDS.map(backend => ({ ...backend, maxConcurrent: 1 })),
    })
    const leases = []
    for (let index = 0; index < 4; index += 1) leases.push(await held(service))
    // Fan-out past the cap degrades to the least loaded backend instead of
    // refusing the request outright.
    const overflow = await held(service)
    expect(VIRTUAL_BACKENDS.some(backend => backend.id === overflow.accountId)).toBe(true)
    const loaded = (await service.snapshot()).providers[0]!
      .accounts.find(account => account.id === overflow.accountId)!
    expect(loaded.inFlight).toBe(2)
    expect(loaded.maxConcurrent).toBe(1)
    for (const lease of [overflow, ...leases]) lease.release({ status: 'success' })
  })

  it('honors an explicit pin on a backend that is at its cap', async () => {
    const service = await groupedService({
      backends: VIRTUAL_BACKENDS.map(backend => ({ ...backend, maxConcurrent: 1 })),
    })
    await service.pinAccount('virtual', 'session-1', 'p1::m1')
    await service.pinAccount('virtual', 'session-2', 'p1::m1')
    const occupying = await held(service, 'session-2')
    expect(occupying.accountId).toBe('p1::m1')
    // A cap steers automatic placement; a switch the operator made stays put.
    const pinned = await held(service, 'session-1')
    expect(pinned.accountId).toBe('p1::m1')
    pinned.release({ status: 'success' })
    occupying.release({ status: 'success' })
  })

  it('weights a provider by the sum of its backend weights', async () => {
    const service = await groupedService({
      backends: [
        { id: 'p1::m1', group: 'p1' },
        { id: 'p1::m2', group: 'p1' },
        { id: 'p1::m3', group: 'p1' },
        { id: 'p2::m1', group: 'p2' },
      ],
      providerStrategy: 'weighted-round-robin',
    })
    const seen = await picks(service, 4)
    expect(seen.filter(id => id.startsWith('p1::'))).toHaveLength(3)
    expect(seen.filter(id => id.startsWith('p2::'))).toHaveLength(1)
  })

  it('spreads by least inflight across providers under a provider strategy', async () => {
    const service = await groupedService({ providerStrategy: 'least-inflight' })
    const first = await held(service)
    const second = await held(service)
    expect(second.accountId.split('::')[0]).not.toBe(first.accountId.split('::')[0])
    first.release({ status: 'success' })
    second.release({ status: 'success' })
  })

  it('lets a stored account preference override the backend cap', async () => {
    const service = new MultiProviderService({ randomInt: () => 0 })
    service.registerProvider({
      id: 'example',
      label: 'Example',
      accounts: () => [
        { id: 'a', label: 'A', authKind: 'api-key', credentialRef: 'a', maxConcurrent: 4 },
        { id: 'b', label: 'B', authKind: 'api-key', credentialRef: 'b' },
      ],
    })
    await service.updatePool('example', {
      affinity: false,
      accounts: [
        { accountId: 'a', enabled: true, weight: 1, priority: 0, maxConcurrent: 1 },
        { accountId: 'b', enabled: true, weight: 1, priority: 0 },
      ],
    })
    // a is capped at 1 by preference, so the second pick must spill to b.
    const first = await service.acquire({ providerId: 'example' })
    expect(first.accountId).toBe('a')
    first.release({ status: 'success' })
    const again = await service.acquire({ providerId: 'example' })
    expect(again.accountId).toBe('a')
    const overflow = await service.acquire({ providerId: 'example' })
    expect(overflow.accountId).toBe('b')
    again.release({ status: 'success' })
    overflow.release({ status: 'success' })
    expect((await service.snapshot()).providers[0]!.accounts[0]!.maxConcurrent).toBe(1)
  })

  it('treats a cap below one as uncapped instead of benching the account', async () => {
    const service = await groupedService({
      backends: [{ id: 'p1::m1', group: 'p1', maxConcurrent: 0 }, { id: 'p2::m1', group: 'p2' }],
    })
    const pool = (await service.snapshot()).providers[0]!
    expect(pool.accounts[0]!.maxConcurrent).toBeUndefined()
    expect(await picks(service, 3)).toEqual(['p1::m1', 'p2::m1', 'p1::m1'])
  })
})
