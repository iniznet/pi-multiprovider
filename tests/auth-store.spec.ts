import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProvider,
  type Credential,
  type Model,
  type OAuthCredential,
} from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mergeAttachments,
  MultiAuthStore,
  sessionsOn,
  SESSION_ATTACHMENTS_PER_POOL_LIMIT,
  SESSION_ATTACHMENT_TTL_MS,
  type SelectionPolicy,
  type VirtualModelTemplate,
  type VirtualProviderConfig,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

async function storeFixture(): Promise<{ directory: string; store: MultiAuthStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-multiprovider-auth-'))
  temporaryDirectories.push(directory)
  return { directory, store: new MultiAuthStore(join(directory, 'multiprovider-auth.json')) }
}

const model: Model<'test-api'> = {
  id: 'model',
  name: 'Model',
  api: 'test-api',
  provider: 'example',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const virtualConfig = {
  id: 'pooled',
  label: 'Pooled',
  models: [{
    id: 'ultra',
    backends: [
      { providerId: 'prov-a', modelId: 'model-a', weight: 2 },
      { providerId: 'prov-b', modelId: 'model-b', weight: 1 },
    ],
  }],
}

describe('MultiAuthStore', () => {
  it('persists virtual backend templates and rejects malformed ones', async () => {
    const { store } = await storeFixture()
    const template: VirtualModelTemplate = {
      api: 'openai-completions',
      baseUrl: 'https://a.invalid',
      reasoning: true,
      thinkingLevelMap: { high: 'high-effort', off: null },
      input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    }
    await store.saveVirtualProvider({
      id: 'pooled',
      label: 'Pooled',
      models: [{
        id: 'ultra',
        backends: [{ providerId: 'prov-a', modelId: 'model-a', template }],
      }],
    })
    const stored = await store.getVirtualProvider('pooled')
    expect(stored?.models[0]?.backends[0]?.template).toEqual(template)
    await expect(store.saveVirtualProvider({
      id: 'pooled',
      label: 'Pooled',
      models: [{
        id: 'ultra',
        backends: [{
          providerId: 'prov-a',
          modelId: 'model-a',
          template: { reasoning: true } as unknown as VirtualModelTemplate,
        }],
      }],
    })).rejects.toThrow('malformed template')
  })

  it('persists atomically with mode 0600 and never exposes credential values in public views', async () => {
    const { store } = await storeFixture()
    const first = await store.addAccount('example', {
      label: 'Work',
      credential: { type: 'api_key', key: 'test-secret-one' },
      weight: 3,
    })
    await Promise.all(Array.from({ length: 6 }, (_, index) => store.addAccount('example', {
      label: `Concurrent ${index + 1}`,
      credential: { type: 'api_key', key: `test-secret-${index + 2}` },
    })))
    await store.updatePool('example', {
      policy: 'weighted-round-robin',
      affinity: false,
      includeUpstream: false,
    })

    const pool = await store.getPool('example')
    expect(pool).toMatchObject({
      providerId: 'example',
      policy: 'weighted-round-robin',
      affinity: false,
      includeUpstream: false,
    })
    expect(pool?.accounts).toHaveLength(7)
    expect(pool?.accounts.find(account => account.id === first.id)).toMatchObject({
      label: 'Work',
      weight: 3,
      authKind: 'api-key',
    })
    expect(JSON.stringify(pool)).not.toContain('test-secret')
    // POSIX mode bits do not exist on NTFS: every file reports 0666 and
    // chmod is a no-op there, so the 0600 assertion only holds elsewhere.
    if (process.platform !== 'win32') {
      expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    }
    expect(await readFile(store.path, 'utf8')).toContain('test-secret-one')
  })

  it('resolves API-key accounts and refreshes one expired OAuth credential once under contention', async () => {
    const { store } = await storeFixture()
    const apiAccount = await store.addAccount('example', {
      label: 'API account',
      credential: { type: 'api_key', key: 'account-api-key', env: { ACCOUNT_REGION: 'west' } },
    })
    const oauthAccount = await store.addAccount('example', {
      label: 'OAuth account',
      credential: {
        type: 'oauth',
        refresh: 'refresh-token',
        access: 'expired-access',
        expires: 0,
      },
    })
    let refreshes = 0
    const provider = createProvider<'test-api'>({
      id: model.provider,
      name: 'Example',
      auth: {
        apiKey: {
          name: 'Example API key',
          async resolve({ credential }) {
            return credential?.key === undefined
              ? undefined
              : {
                  auth: { apiKey: credential.key },
                  ...(credential.env === undefined ? {} : { env: credential.env }),
                  source: 'stored test key',
                }
          },
        },
        oauth: {
          name: 'Example OAuth',
          async login() {
            throw new Error('not used')
          },
          async refresh(credential): Promise<OAuthCredential> {
            refreshes += 1
            return {
              ...credential,
              access: 'refreshed-access',
              expires: Date.now() + 10 * 60_000,
            }
          },
          async toAuth(credential) {
            return { apiKey: credential.access }
          },
        },
      },
      models: [model],
      api: {
        stream() {
          throw new Error('not used')
        },
        streamSimple() {
          throw new Error('not used')
        },
      },
    })
    const signal = new AbortController().signal

    await expect(store.resolveAccount(provider, apiAccount.id, signal)).resolves.toMatchObject({
      auth: { apiKey: 'account-api-key' },
      env: { ACCOUNT_REGION: 'west' },
      source: 'API account · stored test key',
    })
    const resolutions = await Promise.all([
      store.resolveAccount(provider, oauthAccount.id, signal),
      store.resolveAccount(provider, oauthAccount.id, signal),
    ])
    expect(resolutions.map(result => result.auth.apiKey)).toEqual([
      'refreshed-access',
      'refreshed-access',
    ])
    expect(refreshes).toBe(1)
    expect(JSON.stringify(await store.getPool('example'))).not.toContain('refreshed-access')
  })

  it('replaces an existing account credential in place, keeping identity and pool settings', async () => {
    const { directory, store } = await storeFixture()
    const account = await store.addAccount('example', {
      label: 'Work',
      credential: { type: 'api_key', key: 'stale-secret' },
      enabled: false,
      weight: 3,
      priority: 1,
    })
    const replaced = await store.replaceAccountCredential('example', account.id, {
      type: 'oauth',
      refresh: 'fresh-refresh',
      access: 'fresh-access',
      expires: Date.now() + 60_000,
    })
    expect(replaced).toMatchObject({
      id: account.id,
      label: 'Work',
      authKind: 'oauth',
      enabled: false,
      weight: 3,
      priority: 1,
      createdAt: account.createdAt,
    })
    expect(replaced.updatedAt >= account.updatedAt).toBe(true)
    const persisted = JSON.parse(await readFile(join(directory, 'multiprovider-auth.json'), 'utf8'))
    expect(persisted.providers.example.accounts).toHaveLength(1)
    expect(persisted.providers.example.accounts[0].credential).toMatchObject({
      type: 'oauth',
      access: 'fresh-access',
    })
    expect(JSON.stringify(await store.getPool('example'))).not.toContain('fresh-access')

    await expect(store.replaceAccountCredential('example', 'missing', {
      type: 'api_key',
      key: 'x',
    })).rejects.toThrow('unknown stored account')
    await expect(store.replaceAccountCredential('example', account.id, {
      type: 'unsupported',
    } as unknown as Credential)).rejects.toThrow('unsupported stored credential type')
  })
})

describe('MultiAuthStore upstream preferences and scheduler settings', () => {
  it('stores, normalizes, and clears upstream preferences per pool', async () => {
    const { store } = await storeFixture()
    await store.addAccount('example', {
      label: 'Extra',
      credential: { type: 'api_key', key: 'test-secret-upstream' },
    })
    const pool = await store.updatePool('example', {
      upstream: { label: '  Team key  ', weight: 4.9, priority: 2.7 },
    })
    expect(pool.upstream).toEqual({ label: 'Team key', weight: 4, priority: 2 })
    const cleared = await store.updatePool('example', { upstream: {} })
    expect(cleared.upstream).toBeUndefined()
    expect((await store.getPool('example'))?.upstream).toBeUndefined()
  })

  it('persists upstream preferences when the first account creates the pool', async () => {
    const { directory, store } = await storeFixture()
    await store.addAccount('example', {
      label: 'Extra',
      credential: { type: 'api_key', key: 'test-secret-upstream' },
      pool: { policy: 'priority', upstream: { label: 'Home', weight: 3 } },
    })
    const reread = new MultiAuthStore(join(directory, 'multiprovider-auth.json'))
    const pool = await reread.getPool('example')
    expect(pool).toMatchObject({ policy: 'priority', upstream: { label: 'Home', weight: 3 } })
  })

  it('rejects malformed upstream preferences on load', async () => {
    const { directory, store } = await storeFixture()
    await writeFile(
      join(directory, 'multiprovider-auth.json'),
      JSON.stringify({
        version: 1,
        providers: {
          example: {
            policy: 'round-robin',
            affinity: true,
            includeUpstream: true,
            upstream: { weight: 'heavy' },
            accounts: [],
          },
        },
      }),
    )
    await expect(store.getPool('example')).rejects.toThrow('malformed upstream weight')
  })

  it('round-trips scheduler settings and clears keys back to defaults', async () => {
    const { directory, store } = await storeFixture()
    expect(await store.getSchedulerSettings()).toEqual({})
    await store.updateSchedulerSettings({ rateLimitCooldownMs: 5_000, quotaCooldownMs: 60_000 })
    await store.updateSchedulerSettings({ rateLimitCooldownMs: undefined, authCooldownMs: 30_000 })
    const reread = new MultiAuthStore(join(directory, 'multiprovider-auth.json'))
    expect(await reread.getSchedulerSettings()).toEqual({
      quotaCooldownMs: 60_000,
      authCooldownMs: 30_000,
    })
  })

  it('drops the scheduler block when the last override clears and rejects invalid values', async () => {
    const { directory, store } = await storeFixture()
    await store.updateSchedulerSettings({ rateLimitCooldownMs: 1_234 })
    await store.updateSchedulerSettings({ rateLimitCooldownMs: undefined })
    const text = await readFile(join(directory, 'multiprovider-auth.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ version: 1, providers: {} })
    await expect(store.updateSchedulerSettings({ rateLimitCooldownMs: -1 })).rejects.toThrow('non-negative')
  })
})

describe('MultiAuthStore virtual providers', () => {
  it('round-trips, updates, lists, and removes virtual providers', async () => {
    const { directory, store } = await storeFixture()
    await store.saveVirtualProvider(virtualConfig)
    expect(await store.listVirtualProviders()).toEqual([virtualConfig])
    const persisted = JSON.parse(await readFile(join(directory, 'multiprovider-auth.json'), 'utf8'))
    expect(persisted.virtuals.pooled.models[0].backends[0].weight).toBe(2)

    await store.saveVirtualProvider({
      ...virtualConfig,
      models: [{ id: 'ultra', backends: [{ providerId: 'prov-a', modelId: 'model-a' }] }],
    })
    const updated = await store.getVirtualProvider('pooled')
    expect(updated?.models[0]?.backends).toEqual([{ providerId: 'prov-a', modelId: 'model-a', weight: 1 }])

    expect(await store.removeVirtualProvider('pooled')).toBe(true)
    expect(await store.listVirtualProviders()).toEqual([])
    expect(await store.removeVirtualProvider('pooled')).toBe(false)
  })

  it('persists virtual pool strategy and backend priority, defaulting round-robin', async () => {
    const { directory, store } = await storeFixture()
    await store.saveVirtualProvider({
      ...virtualConfig,
      strategy: 'priority',
      models: [{
        id: 'ultra',
        backends: [
          { providerId: 'prov-a', modelId: 'model-a', priority: 2 },
          { providerId: 'prov-b', modelId: 'model-b' },
        ],
      }],
    })
    const stored = await store.getVirtualProvider('pooled')
    expect(stored?.strategy).toBe('priority')
    expect(stored?.models[0]?.backends[0]).toMatchObject({ priority: 2 })
    expect(stored?.models[0]?.backends[1]).toMatchObject({ weight: 1 })
    expect(stored?.models[0]?.backends[1]?.priority).toBeUndefined()
    // Reload from disk: normalization preserves the strategy and priority.
    const reloaded = await new MultiAuthStore(join(directory, 'multiprovider-auth.json'))
      .getVirtualProvider('pooled')
    expect(reloaded?.strategy).toBe('priority')
    expect(reloaded?.models[0]?.backends[0]?.priority).toBe(2)
  })

  it('records, TTL-prunes, and clears shared session attachments', async () => {
    const { directory, store } = await storeFixture()
    const path = join(directory, 'multiprovider-auth.json')
    await store.recordSessionAttachment('pooled::ultra', 'session-1',
      { accountId: 'hypercharm::glm', label: 'HyperCharm · glm', explicit: false }, 1_000)
    await store.recordSessionAttachment('pooled::ultra', 'session-2',
      { accountId: 'commandcode::glm', explicit: true }, 2_000)
    await store.recordSessionAttachment('other::model', 'session-3',
      { accountId: 'a', explicit: false }, 3_000)

    const all = await store.listSessionAttachments(Number.MAX_SAFE_INTEGER, 4_000)
    expect(all.map(entry => entry.poolId + '/' + entry.key))
      .toEqual(['other::model/session-3', 'pooled::ultra/session-2', 'pooled::ultra/session-1'])

    // Freshness is the only cross-process liveness signal pi has: a row nobody
    // refreshed disappears, and the next write drops it from disk too.
    expect((await store.listSessionAttachments(2_000, 4_000)).map(entry => entry.key))
      .toEqual(['session-3', 'session-2'])
    // A write is the natural moment to drop rows nobody has refreshed: a closed
    // tab never clears its own attachment.
    await store.recordSessionAttachment('pooled::ultra', 'session-4',
      { accountId: 'b', explicit: false }, SESSION_ATTACHMENT_TTL_MS + 10_000)
    const after = JSON.parse(await readFile(path, 'utf8'))
    expect(Object.keys(after.sessions)).toEqual(['pooled::ultra'])
    expect(Object.keys(after.sessions['pooled::ultra'])).toEqual(['session-4'])

    expect(await store.clearSessionAttachment('pooled::ultra', 'session-4')).toBe(true)
    expect(await store.clearSessionAttachment('pooled::ultra', 'session-4')).toBe(false)
    // An attachment never carries credential material.
    const emptied = JSON.parse(await readFile(path, 'utf8'))
    expect(emptied.sessions).toBeUndefined()
    await store.recordSessionAttachment('pooled::ultra', 'session-5',
      { accountId: 'a', label: 'Alpha', explicit: false }, 1)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(Object.keys(stored.sessions['pooled::ultra']['session-5']).sort())
      .toEqual(['accountId', 'explicit', 'label', 'updatedAt'])
  })

  it('persists a provider strategy and per-backend concurrency caps', async () => {
    const { store } = await storeFixture()
    const saved = await store.saveVirtualProvider({
      ...virtualConfig,
      providerStrategy: 'weighted-round-robin',
      models: [{
        id: 'ultra',
        backends: [
          { providerId: 'prov-a', modelId: 'model-a', weight: 2, maxConcurrent: 2 },
          // 0 means "no cap": storing it would bench the backend outright.
          { providerId: 'prov-b', modelId: 'model-b', weight: 1, maxConcurrent: 0 },
        ],
      }],
    })
    expect(saved.providerStrategy).toBe('weighted-round-robin')
    expect(saved.models[0]!.backends[0]!.maxConcurrent).toBe(2)
    expect('maxConcurrent' in saved.models[0]!.backends[1]!).toBe(false)
    const listed = await store.listVirtualProviders()
    expect(listed[0]!.providerStrategy).toBe('weighted-round-robin')
    expect(listed[0]!.models[0]!.backends[0]!.maxConcurrent).toBe(2)
  })

  it('leaves providerStrategy absent until an operator chooses one', async () => {
    const { directory, store } = await storeFixture()
    const saved = await store.saveVirtualProvider(virtualConfig)
    expect('providerStrategy' in saved).toBe(false)
    const raw = JSON.parse(await readFile(join(directory, 'multiprovider-auth.json'), 'utf8'))
    expect('providerStrategy' in raw.virtuals.pooled).toBe(false)
    // A strategy outside the enum is a config error, not a silent fallback. The
    // cast stands in for hand-edited JSON, which is where a bad value arrives.
    await expect(store.saveVirtualProvider(
      { ...virtualConfig, providerStrategy: 'fastest' } as unknown as VirtualProviderConfig,
    )).rejects.toThrow('malformed strategy for virtual provider "pooled"')
  })

  it('stores an account concurrency cap and clears it with zero', async () => {
    const { store } = await storeFixture()
    const account = await store.addAccount('example', { label: 'Work', credential: { type: 'api_key', key: 'k' } })
    expect('maxConcurrent' in account).toBe(false)
    expect((await store.updateAccount('example', account.id, { maxConcurrent: 3 })).maxConcurrent).toBe(3)
    expect('maxConcurrent' in await store.updateAccount('example', account.id, { maxConcurrent: 0 })).toBe(false)
  })

  it('exposes one process\'s attachments to another through the shared file', async () => {
    // Two store instances over one path stand in for two terminal tabs: neither
    // shares memory with the other, so the file is the only cross-process view.
    const { directory, store: tabA } = await storeFixture()
    const tabB = new MultiAuthStore(join(directory, 'multiprovider-auth.json'))
    await tabA.recordSessionAttachment('pooled::ultra', 'session-a',
      { accountId: 'hypercharm::glm-5.3-flash', label: 'HyperCharm · glm-5.3-flash', explicit: false }, 1_000)
    expect((await tabB.listSessionAttachments(Number.MAX_SAFE_INTEGER, 2_000))[0])
      .toMatchObject({
        poolId: 'pooled::ultra',
        key: 'session-a',
        accountId: 'hypercharm::glm-5.3-flash',
        explicit: false,
      })
    // tabB has no local pin for that session, so the merge is what surfaces it.
    const merged = mergeAttachments([], await tabB.listSessionAttachments(Number.MAX_SAFE_INTEGER, 2_000), 'pooled::ultra')
    expect(merged).toEqual([{
      key: 'session-a',
      accountId: 'hypercharm::glm-5.3-flash',
      explicit: false,
      remote: true,
    }])
    expect(sessionsOn(merged, 'hypercharm::glm-5.3-flash', 'session-b')).toBe('1 other')
    // Past the TTL the peer's row is simply gone, not shown as an active session.
    expect(await tabB.listSessionAttachments(500, 2_000)).toEqual([])
  })

  it('bounds stored sessions per pool and rejects malformed attachments', async () => {
    const { directory, store } = await storeFixture()
    const path = join(directory, 'multiprovider-auth.json')
    for (let index = 0; index <= SESSION_ATTACHMENTS_PER_POOL_LIMIT; index += 1) {
      await store.recordSessionAttachment('pooled::ultra', 'session-' + index,
        { accountId: 'a', explicit: false }, 1_000 + index)
    }
    const kept = await store.listSessionAttachments(Number.MAX_SAFE_INTEGER, 2_000)
    expect(kept).toHaveLength(SESSION_ATTACHMENTS_PER_POOL_LIMIT)
    // The oldest row is the one dropped.
    expect(kept.some(entry => entry.key === 'session-0')).toBe(false)

    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {},
      sessions: { pooled: { 'session-1': { accountId: '', explicit: false, updatedAt: 1 } } },
    }))
    await expect(new MultiAuthStore(path).listSessionAttachments())
      .rejects.toThrow('malformed session attachment')
  })

  it('persists the virtual pool affinity opt-out and omits the default', async () => {
    const { directory, store } = await storeFixture()
    const path = join(directory, 'multiprovider-auth.json')
    await store.saveVirtualProvider({ ...virtualConfig, affinity: false })
    expect((await store.getVirtualProvider('pooled'))?.affinity).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8')).virtuals.pooled.affinity).toBe(false)

    await store.saveVirtualProvider({ ...virtualConfig, affinity: true })
    // Affinity on is the default, so it is not written to disk at all.
    expect(JSON.parse(await readFile(path, 'utf8')).virtuals.pooled.affinity).toBeUndefined()
    expect((await new MultiAuthStore(path).getVirtualProvider('pooled'))?.affinity).toBeUndefined()

    await expect(store.saveVirtualProvider({
      ...virtualConfig,
      affinity: 'sticky' as unknown as boolean,
    })).rejects.toThrow('malformed affinity')
  })

  it('persists backend template compat flags and rejects malformed ones', async () => {
    const { directory, store } = await storeFixture()
    const compat = { supportsReasoningEffort: false, maxTokensField: 'max_tokens' } as const
    const template = {
      api: 'openai-completions' as const,
      baseUrl: 'https://opencode.ai/zen/go/v1',
      reasoning: true,
      compat,
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 },
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    await store.saveVirtualProvider({
      ...virtualConfig,
      models: [{ id: 'ultra', backends: [{ providerId: 'prov-a', modelId: 'model-a', template }] }],
    })
    const stored = await store.getVirtualProvider('pooled')
    expect(stored?.models[0]?.backends[0]?.template?.compat).toEqual(compat)
    const reloaded = await new MultiAuthStore(join(directory, 'multiprovider-auth.json'))
      .getVirtualProvider('pooled')
    expect(reloaded?.models[0]?.backends[0]?.template?.compat).toEqual(compat)

    const broken = { ...template, compat: 'nope' } as unknown as VirtualModelTemplate
    await expect(store.saveVirtualProvider({
      ...virtualConfig,
      models: [{ id: 'ultra', backends: [{ providerId: 'prov-a', modelId: 'model-a', template: broken }] }],
    })).rejects.toThrow('malformed template')
  })

  it('rejects unknown virtual pool strategies on save and load', async () => {
    const { store } = await storeFixture()
    const invalidStrategy: string = 'chaos'
    await expect(store.saveVirtualProvider({
      ...virtualConfig,
      strategy: invalidStrategy as SelectionPolicy,
    })).rejects.toThrow('malformed strategy')
    const { directory } = await storeFixture()
    const path = join(directory, 'multiprovider-auth.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {},
      virtuals: { pooled: { ...virtualConfig, strategy: invalidStrategy } },
    }))
    await expect(new MultiAuthStore(path).listVirtualProviders()).rejects.toThrow('malformed strategy')
  })

  it('rejects malformed virtual provider configs on save and load', async () => {
    const { store } = await storeFixture()
    await expect(store.saveVirtualProvider({ ...virtualConfig, id: '' })).rejects.toThrow('virtual provider id')
    await expect(store.saveVirtualProvider({ ...virtualConfig, id: 'bad::id' })).rejects.toThrow('virtual provider id')
    await expect(store.saveVirtualProvider({
      ...virtualConfig,
      models: [{ id: 'ultra', backends: [] }],
    })).rejects.toThrow('backends')
    await expect(store.saveVirtualProvider({
      ...virtualConfig,
      models: [{
        id: 'ultra',
        backends: [
          { providerId: 'prov-a', modelId: 'model-a' },
          { providerId: 'prov-a', modelId: 'model-a' },
        ],
      }],
    })).rejects.toThrow('duplicate backend')
    await expect(store.saveVirtualProvider({
      ...virtualConfig,
      models: [{ id: 'ultra', backends: [{ providerId: 'prov-a', modelId: 'model::a' }] }],
    })).rejects.toThrow('backend model id')
    const { directory } = await storeFixture()
    const path = join(directory, 'multiprovider-auth.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {},
      virtuals: { pooled: { id: 'pooled', label: 'Pooled', models: 'nope' } },
    }))
    await expect(new MultiAuthStore(path).listVirtualProviders()).rejects.toThrow('malformed models')
  })
})
