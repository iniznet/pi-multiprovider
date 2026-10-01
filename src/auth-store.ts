import { access, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Api,
  AuthContext,
  AuthResult,
  Credential,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  SELECTION_POLICIES,
  SCHEDULER_SETTING_KEYS,
  SESSION_ATTACHMENT_TTL_MS,
  SESSION_ATTACHMENTS_PER_POOL_LIMIT,
} from './types.ts'
import { normalizeProviderQuotaEntry, normalizeBillingPolicy } from './quota.ts'
import type {
  AuthKind,
  BillingPolicy,
  ProviderQuotaState,
  SessionAttachment,
  SessionAttachmentEntry,
  SchedulerSettings,
  SchedulerSettingsPatch,
  SelectionPolicy,
  VirtualBackend,
  VirtualModelConfig,
  VirtualModelTemplate,
  VirtualProviderConfig,
} from './types.ts'

export const MULTIPROVIDER_AUTH_FILE = 'multiprovider-auth.json'

export interface MultiAuthAccount {
  id: string
  label: string
  authKind: AuthKind
  enabled: boolean
  weight: number
  priority: number
  maxConcurrent?: number
  createdAt: string
  updatedAt: string
}

export interface MultiAuthUpstreamPreferences {
  label?: string
  weight?: number
  priority?: number
  maxConcurrent?: number
}

export interface MultiAuthPool {
  providerId: string
  policy: SelectionPolicy
  affinity: boolean
  includeUpstream: boolean
  upstream?: MultiAuthUpstreamPreferences
  accounts: MultiAuthAccount[]
}

export interface AddMultiAuthAccount {
  label: string
  credential: Credential
  enabled?: boolean
  weight?: number
  priority?: number
  pool?: MultiAuthPoolSettings
}

export interface MultiAuthPoolSettings {
  policy?: SelectionPolicy
  affinity?: boolean
  includeUpstream?: boolean
  upstream?: MultiAuthUpstreamPreferences
}

export interface MultiAuthAccountSettings {
  label?: string
  enabled?: boolean
  weight?: number
  priority?: number
  maxConcurrent?: number
}

interface PersistedAccount extends MultiAuthAccount {
  credential: Credential
}

interface PersistedPool {
  policy: SelectionPolicy
  affinity: boolean
  includeUpstream: boolean
  upstream?: MultiAuthUpstreamPreferences
  accounts: PersistedAccount[]
}

interface PersistedProviderQuota {
  billing?: BillingPolicy
  blockedUntil?: number
  reason?: string
  maxConcurrent?: number
}

interface PersistedState {
  version: 1
  scheduler?: SchedulerSettings
  providers: Record<string, PersistedPool>
  virtuals?: Record<string, VirtualProviderConfig>
  providerQuota?: Record<string, PersistedProviderQuota>
  // pool id -> session key -> attachment. Cross-process view of who is
  // serving what; carries session ids, account ids, and labels only.
  sessions?: Record<string, Record<string, SessionAttachment>>
}

const DEFAULT_POLICY: SelectionPolicy = 'round-robin'
const LOCK_STALE_MS = 120_000
const LOCK_TIMEOUT_MS = 15_000
const OAUTH_REFRESH_SKEW_MS = 5 * 60_000
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])

function emptyState(): PersistedState {
  return { version: 1, providers: {} }
}

function normalizeProviderQuota(value: unknown): Record<string, PersistedProviderQuota> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed provider quota section')
  }
  const normalized: Record<string, PersistedProviderQuota> = {}
  for (const [providerId, entry] of Object.entries(value)) {
    assertSafeKey(providerId, 'provider id')
    const parsed = normalizeProviderQuotaEntry(entry)
    if (Object.keys(parsed).length > 0) normalized[providerId] = parsed
  }
  return normalized
}

function assertSafeKey(value: string, label: string): void {
  if (value.trim() === '' || unsafeKeys.has(value)) throw new Error(`multiprovider: invalid ${label}`)
}

// A stored attachment is read back on every list, so its shape is validated at
// load: a hand-edited or half-written row must fail loudly rather than render a
// bogus session count.
function assertSessionAttachment(value: unknown, poolId: string): asserts value is SessionAttachment {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`multiprovider: malformed session attachment in "${poolId}"`)
  }
  const candidate = value as Partial<SessionAttachment>
  if (typeof candidate.accountId !== 'string' || candidate.accountId === ''
    || typeof candidate.explicit !== 'boolean'
    || typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)
    || (candidate.label !== undefined && typeof candidate.label !== 'string')) {
    throw new Error(`multiprovider: malformed session attachment in "${poolId}"`)
  }
}

function assertCredential(value: unknown): asserts value is Credential {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('multiprovider: malformed stored credential')
  }
  const type = (value as { type?: unknown }).type
  if (type !== 'api_key' && type !== 'oauth') {
    throw new Error('multiprovider: unsupported stored credential type')
  }
}

function assertUpstreamPreferences(value: unknown): asserts value is MultiAuthUpstreamPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed upstream preferences')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.label !== undefined && typeof candidate.label !== 'string') {
    throw new Error('multiprovider: malformed upstream label')
  }
  for (const key of ['weight', 'priority', 'maxConcurrent'] as const) {
    const entry = candidate[key]
    if (entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry))) {
      throw new Error(`multiprovider: malformed upstream ${key}`)
    }
  }
}

function assertSchedulerSettings(value: unknown): asserts value is SchedulerSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('multiprovider: malformed scheduler settings')
  }
  const candidate = value as Record<string, unknown>
  for (const key of SCHEDULER_SETTING_KEYS) {
    const entry = candidate[key]
    if (entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)) {
      throw new Error(`multiprovider: malformed scheduler setting "${key}"`)
    }
  }
}

const VIRTUAL_ID_SEPARATOR = '::'

function assertVirtualId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes(VIRTUAL_ID_SEPARATOR)) {
    throw new Error(`multiprovider: malformed virtual ${label}`)
  }
  assertSafeKey(value, `virtual ${label}`)
}

function normalizeVirtualTemplate(value: unknown, backendLabel: string): VirtualModelTemplate | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`multiprovider: malformed template for ${backendLabel}`)
  }
  const malformed = () => new Error(`multiprovider: malformed template for ${backendLabel}`)
  const candidate = value as Partial<VirtualModelTemplate>
  const input = candidate.input as unknown
  if (
    typeof candidate.api !== 'string' || candidate.api === ''
    || typeof candidate.baseUrl !== 'string' || candidate.baseUrl === ''
    || typeof candidate.reasoning !== 'boolean'
    || !Array.isArray(input) || input.some(entry => typeof entry !== 'string')
    || typeof candidate.cost !== 'object' || candidate.cost === null
    || typeof candidate.contextWindow !== 'number' || !Number.isFinite(candidate.contextWindow)
    || candidate.contextWindow <= 0
    || typeof candidate.maxTokens !== 'number' || !Number.isFinite(candidate.maxTokens)
    || candidate.maxTokens <= 0
  ) throw malformed()
  const cost = candidate.cost as Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', unknown>> & { tiers?: unknown }
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const rate = cost[field]
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw malformed()
  }
  let thinkingLevelMap: Record<string, string | null> | undefined
  if (candidate.thinkingLevelMap !== undefined) {
    if (typeof candidate.thinkingLevelMap !== 'object' || candidate.thinkingLevelMap === null) throw malformed()
    thinkingLevelMap = {}
    for (const [level, effort] of Object.entries(candidate.thinkingLevelMap)) {
      if (typeof effort !== 'string' && effort !== null) throw malformed()
      thinkingLevelMap[level] = effort
    }
  }
  let compat: VirtualModelTemplate['compat'] | undefined
  if (candidate.compat !== undefined) {
    if (typeof candidate.compat !== 'object' || candidate.compat === null || Array.isArray(candidate.compat)) {
      throw malformed()
    }
    // Provider-owned opaque flags: validated as a record, passed through as-is
    // so pi-ai sees exactly what the backing model advertised.
    compat = candidate.compat
  }
  const rates = {
    input: cost.input as number,
    output: cost.output as number,
    cacheRead: cost.cacheRead as number,
    cacheWrite: cost.cacheWrite as number,
  }
  const tiers = Array.isArray(cost.tiers)
    ? (cost.tiers as VirtualModelTemplate['cost']['tiers'])
    : undefined
  return {
    api: candidate.api,
    baseUrl: candidate.baseUrl,
    reasoning: candidate.reasoning,
    ...(thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: thinkingLevelMap as VirtualModelTemplate['thinkingLevelMap'] }),
    ...(compat === undefined ? {} : { compat }),
    input: input as VirtualModelTemplate['input'],
    cost: tiers === undefined ? rates : { ...rates, tiers },
    contextWindow: candidate.contextWindow,
    maxTokens: candidate.maxTokens,
  }
}

function normalizeVirtualProvider(value: unknown): VirtualProviderConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('multiprovider: malformed virtual provider')
  }
  const candidate = value as Partial<VirtualProviderConfig>
  assertVirtualId(candidate.id, 'provider id')
  if (typeof candidate.label !== 'string' || candidate.label.trim() === '') {
    throw new Error(`multiprovider: malformed label for virtual provider "${candidate.id}"`)
  }
  if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
    throw new Error(`multiprovider: malformed models for virtual provider "${candidate.id}"`)
  }
  const models = candidate.models.map(modelValue => {
    if (typeof modelValue !== 'object' || modelValue === null) {
      throw new Error(`multiprovider: malformed model for virtual provider "${candidate.id}"`)
    }
    const model = modelValue as Partial<VirtualModelConfig>
    assertVirtualId(model.id, 'model id')
    if (!Array.isArray(model.backends) || model.backends.length === 0) {
      throw new Error(`multiprovider: malformed backends for virtual model "${model.id}"`)
    }
    const seen = new Set<string>()
    const backends = model.backends.map(backendValue => {
      if (typeof backendValue !== 'object' || backendValue === null) {
        throw new Error(`multiprovider: malformed backend for virtual model "${model.id}"`)
      }
      const backend = backendValue as Partial<VirtualBackend>
      assertVirtualId(backend.providerId, 'backend provider id')
      assertVirtualId(backend.modelId, 'backend model id')
      if (backend.enabled !== undefined && typeof backend.enabled !== 'boolean') {
        throw new Error(`multiprovider: malformed backend enabled for virtual model "${model.id}"`)
      }
      const key = backend.providerId + VIRTUAL_ID_SEPARATOR + backend.modelId
      if (seen.has(key)) {
        throw new Error(`multiprovider: duplicate backend "${key}" for virtual model "${model.id}"`)
      }
      seen.add(key)
      const template = normalizeVirtualTemplate(
        backend.template,
        `virtual model "${model.id}" backend "${backend.providerId}/${backend.modelId}"`,
      )
      const priority = normalizeBackendPriority(backend.priority)
      const maxConcurrent = normalizeConcurrency(backend.maxConcurrent)
      return {
        providerId: backend.providerId,
        modelId: backend.modelId,
        ...(backend.enabled === undefined ? {} : { enabled: backend.enabled }),
        weight: normalizeWeight(backend.weight),
        ...(priority === 0 ? {} : { priority }),
        ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
        ...(template === undefined ? {} : { template }),
      }
    })
    return {
      id: model.id,
      ...(model.label === undefined || model.label.trim() === '' ? {} : { label: model.label.trim() }),
      backends,
    }
  })
  const strategy = normalizeStrategy(candidate.strategy, candidate.id)
  const providerStrategy = normalizeStrategy(candidate.providerStrategy, candidate.id)
  if (candidate.affinity !== undefined && typeof candidate.affinity !== 'boolean') {
    throw new Error(`multiprovider: malformed affinity for virtual provider "${candidate.id}"`)
  }
  return {
    id: candidate.id,
    label: candidate.label.trim(),
    ...(strategy === undefined || strategy === 'round-robin' ? {} : { strategy }),
    // Absent means one flat pass, so nothing is written until a provider-level
    // strategy is actually chosen.
    ...(providerStrategy === undefined ? {} : { providerStrategy }),
    // Affinity on is the default, so only an explicit opt-out is persisted.
    ...(candidate.affinity ? {} : candidate.affinity === false ? { affinity: false } : {}),
    models,
  }
}

function parseState(text: string): PersistedState {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) {
    throw new Error('multiprovider: auth store must contain an object')
  }
  const candidate = value as Partial<PersistedState>
  if (candidate.version !== 1 || typeof candidate.providers !== 'object' || candidate.providers === null) {
    throw new Error('multiprovider: unsupported auth store format')
  }
  if (candidate.scheduler !== undefined) assertSchedulerSettings(candidate.scheduler)
  for (const [providerId, poolValue] of Object.entries(candidate.providers)) {
    assertSafeKey(providerId, 'provider id')
    if (typeof poolValue !== 'object' || poolValue === null) {
      throw new Error(`multiprovider: malformed pool for "${providerId}"`)
    }
    const pool = poolValue as Partial<PersistedPool>
    if (!Array.isArray(pool.accounts)) {
      throw new Error(`multiprovider: malformed accounts for "${providerId}"`)
    }
    if (pool.upstream !== undefined) assertUpstreamPreferences(pool.upstream)
    for (const accountValue of pool.accounts) {
      if (typeof accountValue !== 'object' || accountValue === null) {
        throw new Error(`multiprovider: malformed account for "${providerId}"`)
      }
      const account = accountValue as Partial<PersistedAccount>
      if (typeof account.id !== 'string' || typeof account.label !== 'string') {
        throw new Error(`multiprovider: malformed account identity for "${providerId}"`)
      }
      assertSafeKey(account.id, 'account id')
      assertCredential(account.credential)
    }
  }
  if (candidate.virtuals !== undefined) {
    for (const virtualValue of Object.values(candidate.virtuals)) {
      normalizeVirtualProvider(virtualValue)
    }
  }
  if (candidate.sessions !== undefined) {
    if (typeof candidate.sessions !== 'object' || candidate.sessions === null
      || Array.isArray(candidate.sessions)) {
      throw new Error('multiprovider: malformed session attachments')
    }
    for (const [poolId, byKey] of Object.entries(candidate.sessions)) {
      assertSafeKey(poolId, 'pool id')
      if (typeof byKey !== 'object' || byKey === null || Array.isArray(byKey)) {
        throw new Error(`multiprovider: malformed session attachments for "${poolId}"`)
      }
      for (const [key, attachment] of Object.entries(byKey)) {
        assertSafeKey(key, 'session key')
        assertSessionAttachment(attachment, poolId)
      }
    }
  }
  if (candidate.providerQuota !== undefined) {
    for (const entry of Object.values(candidate.providerQuota)) {
      normalizeProviderQuotaEntry(entry)
    }
  }
  return candidate as PersistedState
}

function publicAccount(account: PersistedAccount): MultiAuthAccount {
  const { credential: _credential, ...snapshot } = account
  return structuredClone(snapshot)
}

function publicPool(providerId: string, pool: PersistedPool): MultiAuthPool {
  return {
    providerId,
    policy: pool.policy,
    affinity: pool.affinity,
    includeUpstream: pool.includeUpstream,
    ...(pool.upstream === undefined ? {} : { upstream: { ...pool.upstream } }),
    accounts: pool.accounts.map(publicAccount),
  }
}

function normalizeWeight(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 1
}

// A concurrency cap is optional: 0 or a malformed value means "no cap" rather
// than "never serve", so a stray entry cannot bench a working backend.
function normalizeConcurrency(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const cap = Math.floor(value)
  return cap >= 1 ? cap : undefined
}

function normalizeBackendPriority(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) >= 0 ? Math.floor(value!) : 0
}

function normalizeStrategy(value: unknown, providerId: string): SelectionPolicy | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(SELECTION_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`multiprovider: malformed strategy for virtual provider "${providerId}"`)
  }
  return value as SelectionPolicy
}

function normalizePriority(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value!) : fallback
}

export function normalizeUpstreamPreferences(
  input: MultiAuthUpstreamPreferences,
): MultiAuthUpstreamPreferences {
  const normalized: MultiAuthUpstreamPreferences = {}
  if (input.label !== undefined) {
    const label = input.label.trim()
    if (label !== '') normalized.label = label
  }
  const maxConcurrent = normalizeConcurrency(input.maxConcurrent)
  if (maxConcurrent !== undefined) normalized.maxConcurrent = maxConcurrent
  if (input.weight !== undefined) normalized.weight = normalizeWeight(input.weight)
  if (input.priority !== undefined) normalized.priority = normalizePriority(input.priority, 0)
  return normalized
}

function expandPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}

const authContext: AuthContext = {
  async env(name) {
    return process.env[name]
  },
  async fileExists(path) {
    try {
      await access(expandPath(path))
      return true
    } catch {
      return false
    }
  },
}

function abortError(): Error {
  return new Error('multiprovider: operation cancelled')
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  let abort: (() => void) | undefined
  try {
    await new Promise<void>((resolvePause, reject) => {
      const timer = setTimeout(resolvePause, ms)
      abort = () => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  } finally {
    if (abort !== undefined) signal?.removeEventListener('abort', abort)
  }
}

export function getMultiAuthPath(): string {
  return join(getAgentDir(), MULTIPROVIDER_AUTH_FILE)
}

export class MultiAuthStore {
  readonly path: string
  private readonly lockPath: string

  constructor(path = getMultiAuthPath()) {
    this.path = path
    this.lockPath = `${path}.lock`
  }

  async listProviderIds(): Promise<string[]> {
    const state = await this.readState()
    return Object.entries(state.providers)
      .filter(([, pool]) => pool.accounts.length > 0)
      .map(([providerId]) => providerId)
      .sort()
  }

  async getPool(providerId: string): Promise<MultiAuthPool | undefined> {
    const state = await this.readState()
    const pool = state.providers[providerId]
    return pool === undefined ? undefined : publicPool(providerId, pool)
  }

  async hasAccounts(providerId: string): Promise<boolean> {
    return (await this.getPool(providerId))?.accounts.some(account => account.enabled) ?? false
  }

  async addAccount(providerId: string, input: AddMultiAuthAccount): Promise<MultiAuthAccount> {
    assertSafeKey(providerId, 'provider id')
    const label = input.label.trim()
    if (label === '') throw new Error('multiprovider: account label is required')
    assertCredential(input.credential)
    return this.mutate(state => {
      const pool = state.providers[providerId] ?? {
        policy: DEFAULT_POLICY,
        affinity: true,
        includeUpstream: true,
        accounts: [],
      }
      state.providers[providerId] = pool
      if (input.pool?.policy !== undefined) pool.policy = input.pool.policy
      if (input.pool?.affinity !== undefined) pool.affinity = input.pool.affinity
      if (input.pool?.includeUpstream !== undefined) pool.includeUpstream = input.pool.includeUpstream
      if (input.pool?.upstream !== undefined) {
        const upstream = normalizeUpstreamPreferences({ ...pool.upstream, ...input.pool.upstream })
        if (Object.keys(upstream).length === 0) delete pool.upstream
        else pool.upstream = upstream
      }
      const now = new Date().toISOString()
      const account: PersistedAccount = {
        id: randomUUID(),
        label,
        authKind: input.credential.type === 'oauth' ? 'oauth' : 'api-key',
        credential: structuredClone(input.credential),
        enabled: input.enabled ?? true,
        weight: normalizeWeight(input.weight),
        priority: normalizePriority(input.priority, pool.accounts.length + 1),
        createdAt: now,
        updatedAt: now,
      }
      pool.accounts.push(account)
      return publicAccount(account)
    })
  }

  /**
   * Replaces an existing account's credential in place. Reauthentication uses
   * this instead of remove + add so the account keeps its id, label, weight,
   * priority, and any session pins pointing at it.
   */
  async replaceAccountCredential(
    providerId: string,
    accountId: string,
    credential: Credential,
  ): Promise<MultiAuthAccount> {
    assertSafeKey(providerId, 'provider id')
    assertCredential(credential)
    return this.mutate(state => {
      const account = state.providers[providerId]?.accounts.find(candidate => candidate.id === accountId)
      if (account === undefined) throw new Error(`multiprovider: unknown stored account "${accountId}"`)
      account.credential = structuredClone(credential)
      account.authKind = credential.type === 'oauth' ? 'oauth' : 'api-key'
      account.updatedAt = new Date().toISOString()
      return publicAccount(account)
    })
  }

  async removeAccount(providerId: string, accountId: string): Promise<boolean> {
    return this.mutate(state => {
      const pool = state.providers[providerId]
      if (pool === undefined) return false
      const index = pool.accounts.findIndex(account => account.id === accountId)
      if (index < 0) return false
      pool.accounts.splice(index, 1)
      if (pool.accounts.length === 0) delete state.providers[providerId]
      return true
    })
  }

  async updatePool(providerId: string, settings: MultiAuthPoolSettings): Promise<MultiAuthPool> {
    assertSafeKey(providerId, 'provider id')
    return this.mutate(state => {
      const pool = state.providers[providerId]
      if (pool === undefined) throw new Error(`multiprovider: unknown stored pool "${providerId}"`)
      if (settings.policy !== undefined) pool.policy = settings.policy
      if (settings.affinity !== undefined) pool.affinity = settings.affinity
      if (settings.includeUpstream !== undefined) pool.includeUpstream = settings.includeUpstream
      if (settings.upstream !== undefined) {
        const upstream = normalizeUpstreamPreferences(settings.upstream)
        if (Object.keys(upstream).length === 0) delete pool.upstream
        else pool.upstream = upstream
      }
      return publicPool(providerId, pool)
    })
  }

  async updateAccount(
    providerId: string,
    accountId: string,
    settings: MultiAuthAccountSettings,
  ): Promise<MultiAuthAccount> {
    return this.mutate(state => {
      const account = state.providers[providerId]?.accounts.find(candidate => candidate.id === accountId)
      if (account === undefined) throw new Error(`multiprovider: unknown stored account "${accountId}"`)
      if (settings.label !== undefined) {
        const label = settings.label.trim()
        if (label === '') throw new Error('multiprovider: account label is required')
        account.label = label
      }
      if (settings.enabled !== undefined) account.enabled = settings.enabled
      if (settings.weight !== undefined) account.weight = normalizeWeight(settings.weight)
      if (settings.priority !== undefined) account.priority = normalizePriority(settings.priority, account.priority)
      if (settings.maxConcurrent !== undefined) {
        const cap = normalizeConcurrency(settings.maxConcurrent)
        if (cap === undefined) delete account.maxConcurrent
        else account.maxConcurrent = cap
      }
      account.updatedAt = new Date().toISOString()
      return publicAccount(account)
    })
  }

  async getSchedulerSettings(): Promise<SchedulerSettings> {
    const state = await this.readState()
    const current = state.scheduler ?? {}
    const result: Partial<Record<(typeof SCHEDULER_SETTING_KEYS)[number], number>> = {}
    for (const key of SCHEDULER_SETTING_KEYS) {
      const value = current[key]
      if (value !== undefined) result[key] = value
    }
    return { ...result } as SchedulerSettings
  }

  async updateSchedulerSettings(settings: SchedulerSettingsPatch): Promise<SchedulerSettings> {
    return this.mutate(state => {
      const current = state.scheduler ?? {}
      const next: Partial<Record<(typeof SCHEDULER_SETTING_KEYS)[number], number>> = {}
      for (const key of SCHEDULER_SETTING_KEYS) {
        const value = key in settings ? settings[key] : current[key]
        if (value === undefined) continue
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`multiprovider: scheduler setting "${key}" must be a non-negative number`)
        }
        next[key] = value
      }
      if (Object.keys(next).length === 0) delete state.scheduler
      else state.scheduler = { ...next } as SchedulerSettings
      return { ...next } as SchedulerSettings
    })
  }

  async listVirtualProviders(): Promise<VirtualProviderConfig[]> {
    const state = await this.readState()
    return Object.values(state.virtuals ?? {})
      .map(provider => structuredClone(provider))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async getVirtualProvider(id: string): Promise<VirtualProviderConfig | undefined> {
    assertSafeKey(id, 'virtual provider id')
    const state = await this.readState()
    const provider = state.virtuals?.[id]
    return provider === undefined ? undefined : structuredClone(provider)
  }

  async saveVirtualProvider(input: VirtualProviderConfig): Promise<VirtualProviderConfig> {
    const provider = normalizeVirtualProvider(input)
    return this.mutate(state => {
      state.virtuals ??= {}
      state.virtuals[provider.id] = structuredClone(provider)
      return structuredClone(provider)
    })
  }

  async removeVirtualProvider(id: string): Promise<boolean> {
    assertSafeKey(id, 'virtual provider id')
    return this.mutate(state => {
      if (state.virtuals?.[id] === undefined) return false
      delete state.virtuals[id]
      if (Object.keys(state.virtuals).length === 0) delete state.virtuals
      return true
    })
  }

  async listProviderQuota(): Promise<Record<string, ProviderQuotaState>> {
    const state = await this.readState()
    return structuredClone(state.providerQuota ?? {})
  }

  async getProviderQuota(providerId: string): Promise<ProviderQuotaState | undefined> {
    assertSafeKey(providerId, 'provider id')
    const state = await this.readState()
    const entry = state.providerQuota?.[providerId]
    return entry === undefined ? undefined : structuredClone(entry)
  }

  async setProviderBilling(providerId: string, billing: BillingPolicy | undefined): Promise<void> {
    assertSafeKey(providerId, 'provider id')
    const normalized = normalizeBillingPolicy(billing)
    await this.mutate(state => {
      if (normalized === undefined) {
        if (state.providerQuota?.[providerId] === undefined) return
        delete state.providerQuota![providerId]!.billing
        if (Object.keys(state.providerQuota![providerId]!).length === 0) delete state.providerQuota![providerId]
        if (Object.keys(state.providerQuota!).length === 0) delete state.providerQuota
        return
      }
      state.providerQuota ??= {}
      const entry: PersistedProviderQuota = state.providerQuota[providerId]
        ?? (state.providerQuota[providerId] = {})
      entry.billing = normalized
    })
  }

  /**
   * Records the provider's own concurrency ceiling. Stored with the provider's
   * billing cycle rather than inside a virtual config, because the limit is a
   * fact about the provider that every pool using it must respect.
   */
  async setProviderLimit(providerId: string, maxConcurrent: number | undefined): Promise<void> {
    assertSafeKey(providerId, 'provider id')
    if (maxConcurrent !== undefined
      && (!Number.isFinite(maxConcurrent) || Math.floor(maxConcurrent) < 1)) {
      throw new Error('multiprovider: provider concurrency limit must be a whole number of at least 1')
    }
    await this.mutate(state => {
      if (maxConcurrent === undefined) {
        if (state.providerQuota?.[providerId] === undefined) return
        delete state.providerQuota![providerId]!.maxConcurrent
        if (Object.keys(state.providerQuota![providerId]!).length === 0) delete state.providerQuota![providerId]
        if (Object.keys(state.providerQuota!).length === 0) delete state.providerQuota
        return
      }
      state.providerQuota ??= {}
      const entry: PersistedProviderQuota = state.providerQuota[providerId]
        ?? (state.providerQuota[providerId] = {})
      entry.maxConcurrent = Math.floor(maxConcurrent)
    })
  }

  async blockProvider(providerId: string, blockedUntil: number, reason: string): Promise<void> {
    assertSafeKey(providerId, 'provider id')
    if (!Number.isFinite(blockedUntil)) {
      throw new Error('multiprovider: provider quota block deadline must be a number')
    }
    await this.mutate(state => {
      state.providerQuota ??= {}
      const entry: PersistedProviderQuota = state.providerQuota[providerId]
        ?? (state.providerQuota[providerId] = {})
      entry.blockedUntil = blockedUntil
      const trimmed = reason.trim()
      if (trimmed === '') delete entry.reason
      else entry.reason = trimmed.slice(0, 300)
    })
  }

  async clearProviderBlock(providerId: string): Promise<boolean> {
    assertSafeKey(providerId, 'provider id')
    return this.mutate(state => {
      const entry = state.providerQuota?.[providerId]
      if (entry === undefined || entry.blockedUntil === undefined) return false
      delete entry.blockedUntil
      delete entry.reason
      if (Object.keys(entry).length === 0) delete state.providerQuota![providerId]
      if (Object.keys(state.providerQuota!).length === 0) delete state.providerQuota
      return true
    })
  }

  // ---- shared session attachments -----------------------------------------
  //
  // Scheduler affinity is in-memory and per process, so a picker in one terminal
  // tab cannot see the sessions other tabs are running. These rows mirror each
  // session's current attachment into the shared store — the only cross-process
  // view of who is serving what. Session ids, account ids, and labels: no
  // credential material of any kind.

  async listSessionAttachments(
    ttlMs: number = SESSION_ATTACHMENT_TTL_MS,
    now: number = Date.now(),
  ): Promise<SessionAttachmentEntry[]> {
    const state = await this.readState()
    const entries: SessionAttachmentEntry[] = []
    for (const [poolId, byKey] of Object.entries(state.sessions ?? {})) {
      for (const [key, attachment] of Object.entries(byKey)) {
        if (now - attachment.updatedAt > ttlMs) continue
        entries.push({ poolId, key, ...attachment })
      }
    }
    return entries.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async recordSessionAttachment(
    poolId: string,
    key: string,
    attachment: Omit<SessionAttachment, 'updatedAt'>,
    now: number = Date.now(),
  ): Promise<void> {
    assertSafeKey(poolId, 'pool id')
    assertSafeKey(key, 'session key')
    await this.mutate(state => {
      const sessions: Record<string, Record<string, SessionAttachment>> = {}
      for (const [existingPool, byKey] of Object.entries(state.sessions ?? {})) {
        // Opportunistic pruning: a closed tab never clears its own row, so a
        // write is the natural moment to drop rows nobody has refreshed.
        const fresh = Object.entries(byKey).filter(([, stored]) =>
          now - stored.updatedAt <= SESSION_ATTACHMENT_TTL_MS)
        if (fresh.length > 0) sessions[existingPool] = Object.fromEntries(fresh)
      }
      const kept = sessions[poolId] ?? {}
      kept[key] = { ...attachment, updatedAt: now }
      // Bound growth per pool, newest first, so the file cannot grow without end.
      const ordered = Object.entries(kept)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, SESSION_ATTACHMENTS_PER_POOL_LIMIT)
      sessions[poolId] = Object.fromEntries(ordered)
      state.sessions = sessions
    })
  }

  async clearSessionAttachment(poolId: string, key: string): Promise<boolean> {
    assertSafeKey(poolId, 'pool id')
    assertSafeKey(key, 'session key')
    return this.mutate(state => {
      const byKey = state.sessions?.[poolId]
      if (byKey === undefined || !(key in byKey)) return false
      delete byKey[key]
      if (Object.keys(byKey).length === 0) delete state.sessions![poolId]
      if (state.sessions !== undefined && Object.keys(state.sessions).length === 0) {
        delete state.sessions
      }
      return true
    })
  }

  async resolveAccount<TApi extends Api>(
    provider: Provider<TApi>,
    accountId: string,
    signal: AbortSignal,
  ): Promise<AuthResult> {
    if (signal.aborted) throw abortError()
    const state = await this.readState()
    const account = state.providers[provider.id]?.accounts.find(candidate => candidate.id === accountId)
    if (account === undefined || !account.enabled) {
      throw new Error(`multiprovider: stored account "${accountId}" is unavailable`)
    }

    if (account.credential.type === 'api_key') {
      const method = provider.auth.apiKey
      if (method === undefined) {
        throw new Error(`multiprovider: provider "${provider.id}" does not support API-key auth`)
      }
      const resolution = await method.resolve({
        ctx: authContext,
        credential: structuredClone(account.credential),
        signal,
      })
      if (resolution === undefined) {
        throw new Error(`multiprovider: stored account "${account.label}" did not resolve auth`)
      }
      return {
        ...resolution,
        source: `${account.label} · ${resolution.source ?? method.name}`,
      }
    }

    const method = provider.auth.oauth
    if (method === undefined) {
      throw new Error(`multiprovider: provider "${provider.id}" does not support OAuth`)
    }
    const resolved = await this.withLock(async () => {
      const lockedState = await this.readStateUnlocked()
      const lockedAccount = lockedState.providers[provider.id]?.accounts.find(
        candidate => candidate.id === accountId,
      )
      if (lockedAccount === undefined || lockedAccount.credential.type !== 'oauth') {
        throw new Error(`multiprovider: stored OAuth account "${accountId}" is unavailable`)
      }
      let credential: OAuthCredential = structuredClone(lockedAccount.credential)
      if (credential.expires <= Date.now() + OAUTH_REFRESH_SKEW_MS) {
        credential = await method.refresh(credential, signal)
        assertCredential(credential)
        if (credential.type !== 'oauth') {
          throw new Error(`multiprovider: provider "${provider.id}" returned invalid OAuth credentials`)
        }
        lockedAccount.credential = structuredClone(credential)
        lockedAccount.updatedAt = new Date().toISOString()
        await this.writeStateUnlocked(lockedState)
      }
      return { credential, label: lockedAccount.label }
    }, signal)
    return {
      auth: await method.toAuth(resolved.credential),
      source: `${resolved.label} · ${method.name}`,
    }
  }

  private async mutate<T>(operation: (state: PersistedState) => T | Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const state = await this.readStateUnlocked()
      const result = await operation(state)
      await this.writeStateUnlocked(state)
      return result
    })
  }

  private async readState(): Promise<PersistedState> {
    return this.readStateUnlocked()
  }

  private async readStateUnlocked(): Promise<PersistedState> {
    try {
      return parseState(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  private async writeStateUnlocked(state: PersistedState): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${MULTIPROVIDER_AUTH_FILE}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  private async withLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const startedAt = Date.now()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    while (handle === undefined) {
      if (signal?.aborted) throw abortError()
      try {
        handle = await open(this.lockPath, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const lock = await stat(this.lockPath)
          if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
            await unlink(this.lockPath)
            continue
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw lockError
        }
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`multiprovider: timed out waiting for auth store lock at ${this.lockPath}`)
        }
        await pause(25, signal)
      }
    }

    try {
      return await operation()
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(this.lockPath).catch(() => undefined)
    }
  }
}
