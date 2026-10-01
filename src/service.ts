import { randomInt, randomUUID } from 'node:crypto'
import { NoAccountAvailableError, UnknownAccountError, UnknownProviderError } from './errors.ts'
import { SCHEDULER_SETTING_KEYS } from './types.ts'
import type {
  AccountLease,
  AccountPreference,
  AcquireOptions,
  AffinityEntry,
  AffinityPin,
  FailureDisposition,
  FailureKind,
  LeaseOutcome,
  MultiProviderSnapshot,
  PoolPreference,
  ProviderAccount,
  ProviderAttemptFailure,
  ProviderRegistration,
  PublicAccountSnapshot,
  SchedulerSettings,
  PublicPoolSnapshot,
  SchedulerOptions,
  SelectionBias,
  SelectionPolicy,
} from './types.ts'

interface RuntimeState {
  inFlight: number
  consecutiveFailures: number
  cooldownUntil: number
  lastSelectedAt?: number
  lastFailureKind?: FailureKind
}

interface EffectiveAccount {
  account: ProviderAccount
  enabled: boolean
  weight: number
  priority: number
  group: string | undefined
  maxConcurrent: number | undefined
  runtime: RuntimeState
}

// Provider-level view of a pool's grouped accounts, aggregated from the members
// that are actually available so both stages of selection see one consistent
// picture of a group's load and order.
interface GroupAggregate {
  key: string
  weight: number
  priority: number
  inFlight: number
  lastSelectedAt: number
}

// Model-level rotation state is namespaced per group once two-level selection
// engages, so each provider keeps its own cursor instead of inheriting one
// shared sequence that would pair a provider with the same model every time.
// NUL cannot appear in a pool id, so namespaced keys cannot alias a real pool.
const ROTATION_SEPARATOR = '\u0000'

function rotationKey(providerId: string, groupKey: string): string {
  return `${providerId}${ROTATION_SEPARATOR}group:${groupKey}`
}

function isPoolKey(key: string, providerId: string): boolean {
  return key === providerId || key.startsWith(providerId + ROTATION_SEPARATOR)
}

function normalizeGroup(value: string | undefined): string | undefined {
  const group = value?.trim()
  return group === undefined || group === '' ? undefined : group
}

// A cap below 1 would make an account permanently unservable; treating it as
// uncapped keeps a malformed config from silently benching a backend.
function normalizeCap(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const cap = Math.floor(value)
  return cap >= 1 ? cap : undefined
}

// Provider ranks accept 0 (the first tier), unlike caps where below one means
// uncapped. Garbage entries are dropped rather than thrown so a hand-edited
// config degrades to the derived ordering instead of refusing to load.
function normalizeGroupPriorities(
  value: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (value === undefined) return undefined
  const ranks: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '' || entry === undefined || !Number.isFinite(entry)) continue
    ranks[key] = Math.max(0, Math.floor(entry))
  }
  return Object.keys(ranks).length === 0 ? undefined : ranks
}

// Same rule per group ceiling, with empty maps collapsed to absent so a pool
// that never set a limit reads identically to one that cleared it later.
function normalizeGroupLimits(
  value: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (value === undefined) return undefined
  const limits: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    const cap = normalizeCap(entry)
    if (cap !== undefined && key.trim() !== '') limits[key] = cap
  }
  return Object.keys(limits).length === 0 ? undefined : limits
}

// Plain round-robin prefers the first healthy account in pool order by
// default so new sessions start on the operator's main account; register a
// provider with selectionBias 'none' for even rotation instead.
const DEFAULT_SELECTION_BIAS: SelectionBias = 'first-account'

const DEFAULTS = {
  defaultPolicy: 'round-robin' as SelectionPolicy,
  affinity: true,
  rateLimitCooldownMs: 60_000,
  quotaCooldownMs: 15 * 60_000,
  authCooldownMs: 5 * 60_000,
  transientBaseCooldownMs: 1_000,
  maxCooldownMs: 60 * 60_000,
  errorsBeforeSwitch: 3,
}

export const SCHEDULER_DEFAULTS: Required<SchedulerSettings> = {
  rateLimitCooldownMs: DEFAULTS.rateLimitCooldownMs,
  quotaCooldownMs: DEFAULTS.quotaCooldownMs,
  authCooldownMs: DEFAULTS.authCooldownMs,
  transientBaseCooldownMs: DEFAULTS.transientBaseCooldownMs,
  maxCooldownMs: DEFAULTS.maxCooldownMs,
  errorsBeforeSwitch: DEFAULTS.errorsBeforeSwitch,
}

function stateKey(providerId: string, accountId: string): string {
  return JSON.stringify([providerId, accountId])
}

function statusFromFailure(failure: ProviderAttemptFailure): number | undefined {
  if (failure.status !== undefined) return failure.status
  const leading = failure.message.match(/^(?:http\s*)?(\d{3})(?::|\s|$)/i)
  const labelled = failure.message.match(/\bstatus(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i)
  const value = leading?.[1] ?? labelled?.[1]
  return value === undefined ? undefined : Number(value)
}

function defaultDisposition(failure: ProviderAttemptFailure): FailureDisposition {
  const message = failure.message.toLowerCase()
  const status = statusFromFailure(failure)
  if (status === 429 || /rate.?limit|too many requests|overloaded/.test(message)) {
    return { kind: 'rate-limit', retryable: true }
  }
  if (status === 402 || /quota|usage.?limit|limit.*reached|out of credits/.test(message)) {
    return { kind: 'quota', retryable: true }
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.*(?:token|api.?key|auth|grant)|(?:token|credential).*(?:expired|invalid)/.test(message)) {
    return { kind: 'auth', retryable: true }
  }
  if (status !== undefined && (status >= 500 || status === 408 || status === 425)) {
    return { kind: 'transient', retryable: true }
  }
  return { kind: 'fatal', retryable: false }
}

export class MultiProviderService {
  private readonly providers = new Map<string, ProviderRegistration>()
  private readonly preferences = new Map<string, PoolPreference>()
  private readonly runtime = new Map<string, RuntimeState>()
  private readonly selectionBias = new Map<string, SelectionBias>()
  private readonly affinity = new Map<string, Map<string, string>>()
  private readonly explicitAffinity = new Map<string, Set<string>>()
  private readonly roundRobinCursor = new Map<string, number>()
  private readonly smoothScores = new Map<string, Map<string, number>>()
  private readonly groupCursor = new Map<string, number>()
  private readonly groupScores = new Map<string, Map<string, number>>()
  private readonly defaults: Required<Omit<SchedulerOptions, 'now' | 'randomId' | 'randomInt'>>
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly randomInt: (maxExclusive: number) => number

  constructor(options: SchedulerOptions = {}) {
    this.defaults = {
      defaultPolicy: options.defaultPolicy ?? DEFAULTS.defaultPolicy,
      affinity: options.affinity ?? DEFAULTS.affinity,
      rateLimitCooldownMs: options.rateLimitCooldownMs ?? DEFAULTS.rateLimitCooldownMs,
      quotaCooldownMs: options.quotaCooldownMs ?? DEFAULTS.quotaCooldownMs,
      authCooldownMs: options.authCooldownMs ?? DEFAULTS.authCooldownMs,
      transientBaseCooldownMs: options.transientBaseCooldownMs ?? DEFAULTS.transientBaseCooldownMs,
      maxCooldownMs: options.maxCooldownMs ?? DEFAULTS.maxCooldownMs,
      errorsBeforeSwitch: options.errorsBeforeSwitch ?? DEFAULTS.errorsBeforeSwitch,
    }
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
    this.randomInt = options.randomInt ?? ((maxExclusive: number) => randomInt(0, maxExclusive))
  }

  registerProvider<TCredentialRef>(registration: ProviderRegistration<TCredentialRef>): () => void {
    if (registration.id.trim() === '') throw new Error('multiprovider: provider id must not be empty')
    if (this.providers.has(registration.id)) {
      throw new Error(`multiprovider: duplicate provider "${registration.id}"`)
    }
    this.providers.set(registration.id, registration as ProviderRegistration)
    this.selectionBias.set(registration.id, registration.selectionBias ?? DEFAULT_SELECTION_BIAS)
    return () => {
      if (this.providers.get(registration.id) !== registration) return
      this.providers.delete(registration.id)
      this.selectionBias.delete(registration.id)
      this.affinity.delete(registration.id)
      this.explicitAffinity.delete(registration.id)
      // Group-scoped model cursors and scores outlive the bare pool id, so an
      // unregister sweeps those entries too.
      for (const key of [...this.roundRobinCursor.keys()]) {
        if (isPoolKey(key, registration.id)) this.roundRobinCursor.delete(key)
      }
      for (const key of [...this.smoothScores.keys()]) {
        if (isPoolKey(key, registration.id)) this.smoothScores.delete(key)
      }
      this.groupCursor.delete(registration.id)
      this.groupScores.delete(registration.id)
    }
  }

  hasProvider(providerId: string): boolean {
    return this.providers.has(providerId)
  }

  async hasEnabledAccounts(providerId: string): Promise<boolean> {
    const registration = this.registration(providerId)
    const pool = this.pool(providerId)
    return (await this.effectiveAccounts(registration, pool)).some(item => item.enabled)
  }

  async acquire<TCredentialRef = unknown>(options: AcquireOptions): Promise<AccountLease<TCredentialRef>> {
    const registration = this.registration(options.providerId)
    const pool = this.pool(options.providerId)
    const accounts = await this.effectiveAccounts(registration, pool)
    const excluded = new Set(options.excludeAccountIds ?? [])
    const now = this.now()
    const available = accounts.filter(item =>
      item.enabled && item.runtime.cooldownUntil <= now && !excluded.has(item.account.id),
    )

    if (available.length === 0) {
      const future = accounts
        .filter(item => item.enabled && !excluded.has(item.account.id) && item.runtime.cooldownUntil > now)
        .map(item => item.runtime.cooldownUntil)
      throw new NoAccountAvailableError(
        options.providerId,
        future.length === 0 ? undefined : Math.min(...future),
      )
    }

    let selected: EffectiveAccount | undefined
    let pinnedId: string | undefined
    let explicitPin = false
    if (options.affinityKey !== undefined) {
      pinnedId = this.affinity.get(options.providerId)?.get(options.affinityKey)
      explicitPin = pinnedId !== undefined
        && this.explicitAffinity.get(options.providerId)?.has(options.affinityKey) === true
      if (explicitPin && !accounts.some(item => item.account.id === pinnedId && item.enabled)) {
        // The explicitly pinned account was removed or disabled: drop the pin
        // and fall back to automatic selection for the rest of the session.
        this.affinity.get(options.providerId)?.delete(options.affinityKey)
        this.explicitAffinity.get(options.providerId)?.delete(options.affinityKey)
        pinnedId = undefined
        explicitPin = false
      }
      // Explicit pins override the pool's affinity setting; implicit pins only
      // apply while the operator left session affinity enabled.
      if ((pool.affinity || explicitPin) && pinnedId !== undefined) {
        selected = available.find(item => item.account.id === pinnedId)
      }
    }
    selected ??= this.select(pool, available)

    if (options.affinityKey !== undefined && pool.affinity && !explicitPin) {
      let table = this.affinity.get(options.providerId)
      if (table === undefined) {
        table = new Map()
        this.affinity.set(options.providerId, table)
      }
      table.set(options.affinityKey, selected.account.id)
    }

    selected.runtime.inFlight += 1
    selected.runtime.lastSelectedAt = now
    let released = false
    const account = selected.account as ProviderAccount<TCredentialRef>

    return {
      id: this.randomId(),
      providerId: options.providerId,
      accountId: account.id,
      account,
      credentialRef: account.credentialRef,
      acquiredAt: now,
      release: (outcome: LeaseOutcome = { status: 'cancelled' }) => {
        if (released) return undefined
        released = true
        selected.runtime.inFlight = Math.max(0, selected.runtime.inFlight - 1)
        if (outcome.status === 'success') this.recordSuccess(options.providerId, account.id)
        else if (outcome.status === 'failure') {
          return this.recordFailure(registration, account, outcome.error)
        }
        return undefined
      },
    }
  }

  async snapshot(): Promise<MultiProviderSnapshot> {
    const providers: PublicPoolSnapshot[] = []
    for (const registration of this.providers.values()) {
      const pool = this.pool(registration.id)
      const effective = await this.effectiveAccounts(registration, pool)
      const now = this.now()
      const accounts: PublicAccountSnapshot[] = effective.map(({
        account, enabled, weight, priority, group, maxConcurrent, runtime,
      }) => ({
        id: account.id,
        label: account.label,
        authKind: account.authKind,
        enabled,
        weight,
        priority,
        ...(group === undefined ? {} : { group }),
        ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
        status: !enabled ? 'disabled' : runtime.cooldownUntil > now ? 'cooldown' : 'ready',
        inFlight: runtime.inFlight,
        consecutiveFailures: runtime.consecutiveFailures,
        ...(runtime.cooldownUntil > now ? { cooldownUntil: runtime.cooldownUntil } : {}),
        ...(runtime.lastSelectedAt === undefined ? {} : { lastSelectedAt: runtime.lastSelectedAt }),
        ...(runtime.lastFailureKind === undefined ? {} : { lastFailureKind: runtime.lastFailureKind }),
        metadata: account.metadata ?? {},
      }))
      providers.push({
        id: registration.id,
        label: registration.label,
        policy: pool.policy,
        ...(pool.groupPolicy === undefined ? {} : { groupPolicy: pool.groupPolicy }),
        ...(pool.groupLimits === undefined ? {} : { groupLimits: { ...pool.groupLimits } }),
        affinity: pool.affinity,
        firstAccountBias: (this.selectionBias.get(registration.id) ?? DEFAULT_SELECTION_BIAS) === 'first-account',
        ...(registration.managementHint === undefined
          ? {}
          : { managementHint: registration.managementHint }),
        accounts,
      })
    }
    return { providers }
  }

  // A patch entry of null clears a setting, undefined leaves it as configured,
  // and a value replaces it. Three pool settings need exactly this, so the rule
  // is stated once instead of a ternary per field.
  private patched<T>(
    value: T | null | undefined,
    current: T | undefined,
    normalize: (entry: T) => T | undefined = entry => entry,
  ): T | undefined {
    if (value === null) return undefined
    if (value === undefined) return current
    return normalize(value)
  }

  async updatePool(
    providerId: string,
    patch: Partial<Pick<PoolPreference, 'policy' | 'affinity' | 'accounts'>>
      & { groupPolicy?: SelectionPolicy | null,
        groupLimits?: Record<string, number> | null,
        groupPriorities?: Record<string, number> | null },
  ): Promise<PublicPoolSnapshot> {
    this.registration(providerId)
    const current = this.pool(providerId)
    // `null` clears the provider-level strategy and returns the pool to one
    // flat pass; `undefined` leaves it untouched.
    const groupPolicy = this.patched(patch.groupPolicy, current.groupPolicy)
    const groupLimits = this.patched(patch.groupLimits, current.groupLimits, normalizeGroupLimits)
    const groupPriorities = this.patched(
      patch.groupPriorities,
      current.groupPriorities,
      normalizeGroupPriorities,
    )
    const next: PoolPreference = {
      providerId,
      policy: patch.policy ?? current.policy,
      ...(groupPolicy === undefined ? {} : { groupPolicy }),
      ...(groupLimits === undefined ? {} : { groupLimits }),
      ...(groupPriorities === undefined ? {} : { groupPriorities }),
      affinity: patch.affinity ?? current.affinity,
      accounts: (patch.accounts ?? current.accounts).map(account => ({ ...account })),
    }
    this.preferences.set(providerId, next)
    const result = (await this.snapshot()).providers.find(provider => provider.id === providerId)
    if (result === undefined) throw new UnknownProviderError(providerId)
    return result
  }

  getPoolPreference(providerId: string): PoolPreference {
    this.registration(providerId)
    return this.pool(providerId)
  }

  // Pre-output retryable errors a stream absorbs on one account before
  // failing over to the next account. Clamped to at least 1 so a stream
  // always abandons an account after a finite number of errors.
  getErrorsBeforeSwitch(): number {
    return Math.max(1, Math.floor(this.defaults.errorsBeforeSwitch))
  }

  updateSchedulerDefaults(settings: SchedulerSettings): void {
    for (const key of SCHEDULER_SETTING_KEYS) {
      const value = settings[key]
      if (value === undefined) continue
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`multiprovider: scheduler setting "${key}" must be a non-negative number`)
      }
      this.defaults[key] = value
    }
  }

  resetHealth(providerId: string, accountId: string): void {
    this.registration(providerId)
    const runtime = this.runtime.get(stateKey(providerId, accountId))
    if (runtime === undefined) return
    runtime.consecutiveFailures = 0
    runtime.cooldownUntil = 0
    delete runtime.lastFailureKind
  }

  // Probe-driven quota blocking: a usage probe found this account's meter
  // window exhausted, so hold it out of selection until the API-reported
  // reset instead of waiting for a failed request to trigger a cooldown.
  coolAccountUntil(providerId: string, accountId: string, until: number): void {
    this.registration(providerId)
    const runtime = this.runtimeFor(providerId, accountId)
    if (until <= runtime.cooldownUntil) return
    runtime.cooldownUntil = until
    runtime.lastFailureKind = 'quota'
  }

  async pinAccount(providerId: string, affinityKey: string, accountId: string): Promise<void> {
    const registration = this.registration(providerId)
    const pool = this.pool(providerId)
    const accounts = await this.effectiveAccounts(registration, pool)
    const target = accounts.find(item => item.account.id === accountId)
    if (target === undefined) throw new UnknownAccountError(providerId, accountId)
    if (!target.enabled) {
      throw new Error(`multiprovider: account "${target.account.label}" is disabled`)
    }
    let table = this.affinity.get(providerId)
    if (table === undefined) {
      table = new Map()
      this.affinity.set(providerId, table)
    }
    table.set(affinityKey, accountId)
    let explicit = this.explicitAffinity.get(providerId)
    if (explicit === undefined) {
      explicit = new Set()
      this.explicitAffinity.set(providerId, explicit)
    }
    explicit.add(affinityKey)
  }

  // Every session currently attached to a pool. Implicit picks and explicit
  // pins are both listed so a fan-out's spread — or its concentration on one
  // credential — is visible instead of guessed at. Unknown pools return an empty
  // list rather than throwing: the argument-completion path calls this
  // speculatively while the user is still typing.
  affinityEntries(providerId: string): AffinityEntry[] {
    if (!this.providers.has(providerId)) return []
    const table = this.affinity.get(providerId)
    if (table === undefined) return []
    const explicit = this.explicitAffinity.get(providerId)
    return [...table.entries()].map(([key, accountId]) => ({
      key,
      accountId,
      explicit: explicit?.has(key) === true,
    }))
  }

  getAffinity(providerId: string, affinityKey: string): AffinityPin | undefined {
    this.registration(providerId)
    const accountId = this.affinity.get(providerId)?.get(affinityKey)
    if (accountId === undefined) return undefined
    return {
      accountId,
      explicit: this.explicitAffinity.get(providerId)?.has(affinityKey) === true,
    }
  }

  clearAffinity(providerId?: string, affinityKey?: string): void {
    if (providerId === undefined) {
      this.affinity.clear()
      this.explicitAffinity.clear()
      return
    }
    if (affinityKey === undefined) {
      this.affinity.delete(providerId)
      this.explicitAffinity.delete(providerId)
      return
    }
    this.affinity.get(providerId)?.delete(affinityKey)
    this.explicitAffinity.get(providerId)?.delete(affinityKey)
  }

  private registration(providerId: string): ProviderRegistration {
    const registration = this.providers.get(providerId)
    if (registration === undefined) throw new UnknownProviderError(providerId)
    return registration
  }

  private pool(providerId: string): PoolPreference {
    const configured = this.preferences.get(providerId)
    return configured === undefined
      ? {
          providerId,
          policy: this.defaults.defaultPolicy,
          affinity: this.defaults.affinity,
          accounts: [],
        }
      : {
          ...configured,
          accounts: configured.accounts.map(account => ({ ...account })),
        }
  }

  private runtimeFor(providerId: string, accountId: string): RuntimeState {
    const key = stateKey(providerId, accountId)
    let runtime = this.runtime.get(key)
    if (runtime === undefined) {
      runtime = { inFlight: 0, consecutiveFailures: 0, cooldownUntil: 0 }
      this.runtime.set(key, runtime)
    }
    return runtime
  }

  private async effectiveAccounts(
    registration: ProviderRegistration,
    pool: PoolPreference,
  ): Promise<EffectiveAccount[]> {
    const inventory = [...await registration.accounts()]
    const seen = new Set<string>()
    const preferences = new Map(pool.accounts.map(account => [account.accountId, account]))
    return inventory.map(account => {
      if (account.id.trim() === '') {
        throw new Error(`multiprovider: provider "${registration.id}" returned an empty account id`)
      }
      if (seen.has(account.id)) {
        throw new Error(`multiprovider: provider "${registration.id}" returned duplicate account "${account.id}"`)
      }
      seen.add(account.id)
      const preference = preferences.get(account.id)
      return {
        account,
        enabled: account.enabled !== false && (preference?.enabled ?? true),
        weight: preference?.weight ?? account.weight ?? 1,
        priority: preference?.priority ?? account.priority ?? 0,
        group: normalizeGroup(account.group),
        maxConcurrent: normalizeCap(preference?.maxConcurrent ?? account.maxConcurrent),
        runtime: this.runtimeFor(registration.id, account.id),
      }
    })
  }

  private select(pool: PoolPreference, accounts: EffectiveAccount[]): EffectiveAccount {
    const providerId = pool.providerId
    // Two-level selection engages only when the operator chose a
    // provider-level strategy and the pool actually has groups; otherwise the
    // pool keeps its single flat pass over accounts. Provider ceilings apply
    // either way, because they filter candidates rather than order them.
    const withinCeiling = this.withGroupHeadroom(accounts, pool.groupLimits)
    if (pool.groupPolicy !== undefined && accounts.some(item => item.group !== undefined)) {
      return this.selectGrouped(providerId, pool, withinCeiling)
    }
    return this.selectBy(providerId, providerId, pool.policy, this.preferHeadroom(withinCeiling))
  }

  // A provider-wide ceiling filters eligibility the same way a per-account cap
  // does, so it works on a flat pool too. Group load counts every eligible
  // member including ones already at their own cap: a model that cannot take
  // more work still holds the slots it has.
  private withGroupHeadroom(
    items: EffectiveAccount[],
    limits: Record<string, number> | undefined,
  ): EffectiveAccount[] {
    if (limits === undefined) return items
    const load = this.groupLoad(items)
    const free = items.filter(item => {
      const limit = limits[this.groupKey(item)]
      return limit === undefined || (load.get(this.groupKey(item)) ?? 0) < limit
    })
    // Every ceiling reached: keep serving the least loaded account rather than
    // refusing, so a limit is never a way to fail a turn.
    return free.length > 0 ? free : [this.leastLoaded(items)]
  }

  private groupKey(item: EffectiveAccount): string {
    return item.group ?? `account:${item.account.id}`
  }

  private groupLoad(items: EffectiveAccount[]): Map<string, number> {
    const load = new Map<string, number>()
    for (const item of items) {
      const key = this.groupKey(item)
      load.set(key, (load.get(key) ?? 0) + item.runtime.inFlight)
    }
    return load
  }

  // Accounts still below their soft cap, or the least loaded account when every
  // eligible one is at it. A cap therefore biases placement instead of turning
  // a busy pool into a hard failure for fan-out callers.
  private preferHeadroom(items: EffectiveAccount[]): EffectiveAccount[] {
    if (!items.some(item => item.maxConcurrent !== undefined)) return items
    const free = items.filter(item => !this.isCapped(item))
    return free.length > 0 ? free : [this.leastLoaded(items)]
  }

  private isCapped(item: EffectiveAccount): boolean {
    return item.maxConcurrent !== undefined && item.runtime.inFlight >= item.maxConcurrent
  }

  private leastLoaded(items: EffectiveAccount[]): EffectiveAccount {
    return [...items].sort((left, right) =>
      left.runtime.inFlight - right.runtime.inFlight
      || (left.runtime.lastSelectedAt ?? 0) - (right.runtime.lastSelectedAt ?? 0),
    )[0]!
  }

  private selectGrouped(
    providerId: string,
    pool: PoolPreference,
    accounts: EffectiveAccount[],
  ): EffectiveAccount {
    const modelPolicy = pool.policy
    // Bucket order is first-appearance order, so both stages follow pool
    // (inventory) order the same way the flat path does.
    const buckets = new Map<string, EffectiveAccount[]>()
    for (const item of accounts) {
      const members = buckets.get(this.groupKey(item))
      if (members === undefined) buckets.set(this.groupKey(item), [item])
      else members.push(item)
    }
    // A group is selectable while it is under its provider ceiling and at least
    // one of its models still has headroom of its own.
    const live = new Map<string, EffectiveAccount[]>()
    for (const group of this.groupAggregates(buckets, pool.groupPriorities)) {
      const limit = pool.groupLimits?.[group.key]
      if (limit !== undefined && group.inFlight >= limit) continue
      const free = buckets.get(group.key)!.filter(item => !this.isCapped(item))
      if (free.length > 0) live.set(group.key, free)
    }
    if (live.size === 0) {
      return this.selectBy(providerId, providerId, modelPolicy, [this.leastLoaded(accounts)])
    }
    const chosen = this.selectGroup(providerId, pool, buckets, live)
    return this.selectBy(providerId, rotationKey(providerId, chosen), modelPolicy, live.get(chosen)!)
  }

  private selectGroup(
    providerId: string,
    pool: PoolPreference,
    buckets: Map<string, EffectiveAccount[]>,
    live: Map<string, EffectiveAccount[]>,
  ): string {
    const groupPolicy = pool.groupPolicy ?? pool.policy
    const candidates = this.groupAggregates(buckets, pool.groupPriorities)
      .filter(group => live.has(group.key))
    if (groupPolicy === 'least-inflight') {
      return [...candidates].sort((left, right) =>
        left.inFlight - right.inFlight
        || left.lastSelectedAt - right.lastSelectedAt,
      )[0]!.key
    }
    if (groupPolicy === 'priority') {
      return [...candidates].sort((left, right) =>
        left.priority - right.priority
        || left.inFlight - right.inFlight
        || left.lastSelectedAt - right.lastSelectedAt,
      )[0]!.key
    }
    if (groupPolicy === 'weighted-round-robin') {
      return this.selectGroupWeighted(providerId, candidates)
    }
    // Plain round-robin: the pool's tie-break bias applies across providers too,
    // so a first-account pool keeps using its primary provider until that
    // provider runs out of headroom.
    if ((this.selectionBias.get(providerId) ?? DEFAULT_SELECTION_BIAS) === 'first-account') {
      return candidates[0]!.key
    }
    let cursor = this.groupCursor.get(providerId)
    if (cursor === undefined) {
      cursor = candidates.length > 1 ? this.randomInt(candidates.length) : 0
      this.groupCursor.set(providerId, cursor)
    }
    const chosen = candidates[cursor % candidates.length]!
    this.groupCursor.set(providerId, (cursor + 1) % candidates.length)
    return chosen.key
  }

  private selectGroupWeighted(providerId: string, candidates: GroupAggregate[]): string {
    let scores = this.groupScores.get(providerId)
    if (scores === undefined) {
      scores = new Map()
      this.groupScores.set(providerId, scores)
    }
    const live = new Set(candidates.map(group => group.key))
    for (const key of scores.keys()) if (!live.has(key)) scores.delete(key)
    const total = candidates.reduce((sum, group) => sum + group.weight, 0)
    let chosen = candidates[0]!
    let best = Number.NEGATIVE_INFINITY
    for (const group of candidates) {
      const score = (scores.get(group.key) ?? 0) + group.weight
      scores.set(group.key, score)
      if (score > best) {
        best = score
        chosen = group
      }
    }
    scores.set(chosen.key, (scores.get(chosen.key) ?? 0) - total)
    return chosen.key
  }

  // Group weight is the sum of member weights, so a provider holding three
  // backends carries three times the share of an equal-weight single backend.
  // Priority is the best (lowest) member priority: a provider qualifies for a
  // priority tier as soon as any of its models sits in it.
  private groupAggregates(
    buckets: Map<string, EffectiveAccount[]>,
    groupPriorities: Record<string, number> | undefined,
  ): GroupAggregate[] {
    return [...buckets].map(([key, members]) => ({
      key,
      weight: members.reduce((sum, item) => sum + Math.max(1, item.weight), 0),
      // An explicit rank wins over the minimum member priority, so ordering
      // providers never depends on which backend happens to carry the number.
      priority: groupPriorities?.[key] ?? Math.min(...members.map(item => item.priority)),
      inFlight: members.reduce((sum, item) => sum + item.runtime.inFlight, 0),
      lastSelectedAt: Math.max(...members.map(item => item.runtime.lastSelectedAt ?? 0)),
    }))
  }

  // `providerId` owns pool-wide settings such as the tie-break bias; `rotation`
  // namespaces per-model cursors once selection is grouped, so each provider
  // advances through its own models instead of inheriting one shared sequence.
  private selectBy(
    providerId: string,
    rotation: string,
    policy: SelectionPolicy,
    accounts: EffectiveAccount[],
  ): EffectiveAccount {
    // Every policy below follows pool (inventory) order — the order the
    // operator configured — never a re-sort by account id.
    if (policy === 'least-inflight') {
      return [...accounts].sort((left, right) =>
        left.runtime.inFlight - right.runtime.inFlight
        || (left.runtime.lastSelectedAt ?? 0) - (right.runtime.lastSelectedAt ?? 0),
      )[0]!
    }
    if (policy === 'priority') {
      return [...accounts].sort((left, right) =>
        left.priority - right.priority
        || left.runtime.inFlight - right.runtime.inFlight
        || (left.runtime.lastSelectedAt ?? 0) - (right.runtime.lastSelectedAt ?? 0),
      )[0]!
    }
    if (policy === 'weighted-round-robin') {
      return this.selectWeighted(rotation, accounts)
    }
    // Plain round-robin. accounts preserves pool (inventory) order, so the
    // first entry is the operator's main account; bias keeps new sessions on
    // it and only spills over while it is cooling down, disabled, or excluded.
    if ((this.selectionBias.get(providerId) ?? DEFAULT_SELECTION_BIAS) === 'first-account') {
      return accounts[0]!
    }
    // Differing weights rotate traffic shares even under this policy; equal
    // (or unset) weights keep the classic even rotation.
    if (accounts.some(item => item.weight !== accounts[0]!.weight)) {
      return this.selectWeighted(rotation, accounts)
    }
    // The rotation cursor starts at a random offset so a fresh process does
    // not always land its first session on the same backend.
    let cursor = this.roundRobinCursor.get(rotation)
    if (cursor === undefined) {
      cursor = accounts.length > 1 ? this.randomInt(accounts.length) : 0
      this.roundRobinCursor.set(rotation, cursor)
    }
    const selected = accounts[cursor % accounts.length]!
    this.roundRobinCursor.set(rotation, (cursor + 1) % accounts.length)
    return selected
  }

  private selectWeighted(providerId: string, accounts: EffectiveAccount[]): EffectiveAccount {
    let scores = this.smoothScores.get(providerId)
    if (scores === undefined) {
      scores = new Map()
      this.smoothScores.set(providerId, scores)
    }
    const live = new Set(accounts.map(item => item.account.id))
    for (const id of scores.keys()) if (!live.has(id)) scores.delete(id)
    const total = accounts.reduce((sum, item) => sum + Math.max(1, item.weight), 0)
    let selected = accounts[0]!
    let best = Number.NEGATIVE_INFINITY
    for (const item of accounts) {
      const score = (scores.get(item.account.id) ?? 0) + Math.max(1, item.weight)
      scores.set(item.account.id, score)
      if (score > best) {
        best = score
        selected = item
      }
    }
    scores.set(selected.account.id, (scores.get(selected.account.id) ?? 0) - total)
    return selected
  }

  private recordSuccess(providerId: string, accountId: string): void {
    const runtime = this.runtimeFor(providerId, accountId)
    runtime.consecutiveFailures = 0
    runtime.cooldownUntil = 0
    delete runtime.lastFailureKind
  }

  private recordFailure(
    registration: ProviderRegistration,
    account: ProviderAccount,
    failure: ProviderAttemptFailure,
  ): FailureDisposition {
    let disposition: FailureDisposition
    try {
      disposition = registration.classifyFailure?.(failure, account)
        ?? defaultDisposition(failure)
    } catch {
      disposition = { kind: 'fatal', retryable: false }
    }
    const runtime = this.runtimeFor(registration.id, account.id)
    runtime.consecutiveFailures += 1
    runtime.lastFailureKind = disposition.kind
    const cooldown = disposition.cooldownMs
      ?? this.defaultCooldown(disposition.kind, runtime.consecutiveFailures)
    runtime.cooldownUntil = Math.max(
      runtime.cooldownUntil,
      this.now() + Math.min(this.defaults.maxCooldownMs, Math.max(0, cooldown)),
    )
    return disposition
  }

  private defaultCooldown(kind: FailureKind, failures: number): number {
    if (kind === 'rate-limit') return this.defaults.rateLimitCooldownMs
    if (kind === 'quota') return this.defaults.quotaCooldownMs
    if (kind === 'auth') return this.defaults.authCooldownMs
    if (kind === 'transient') {
      return this.defaults.transientBaseCooldownMs * 2 ** Math.min(10, failures - 1)
    }
    return 0
  }
}
