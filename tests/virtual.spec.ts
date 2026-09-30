import {
  createAssistantMessageEventStream,
  createProvider,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthContext,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StopReason,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  captureVirtualModelTemplate,
  createVirtualIntegrations,
  createVirtualProvider,
  healVirtualTemplates,
  type FailoverInfo,
  MultiProviderService,
  virtualSchedulerId,
  type VirtualProviderConfig,
  type VirtualProviderDependencies,
} from '../src/index.ts'
import type { ProviderHeaders } from '@earendil-works/pi-ai'

// pi-ai attaches transformHeaders via ModelsRequestTransforms at the runtime
// boundary; the test backend handlers observe the merged options object.
type CapturedOptions = SimpleStreamOptions & {
  transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const modelA: Model<'test-api'> = {
  id: 'model-a',
  name: 'Model A',
  api: 'test-api',
  provider: 'prov-a',
  baseUrl: 'https://a.invalid',
  reasoning: false,
  thinkingLevelMap: { high: 'high-effort', off: null },
  input: ['text'],
  cost: zeroCost,
  contextWindow: 1_000,
  maxTokens: 100,
}

const modelB: Model<'test-api'> = {
  ...modelA,
  id: 'model-b',
  name: 'Model B',
  provider: 'prov-b',
  baseUrl: 'https://b.invalid',
}

const config: VirtualProviderConfig = {
  id: 'pooled',
  label: 'Pooled',
  models: [{
    id: 'ultra',
    backends: [
      { providerId: 'prov-a', modelId: 'model-a' },
      { providerId: 'prov-b', modelId: 'model-b' },
    ],
  }],
}

const context: TranscriptContext = normalizeContext({ messages: [] })

const authContext: AuthContext = {
  async env() {
    return undefined
  },
  async fileExists() {
    return false
  },
}

function message(
  stopReason: StopReason,
  options: { text?: string; errorMessage?: string } = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
    api: 'test-api',
    provider: 'prov-a',
    model: 'model-a',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    timestamp: Date.now(),
  }
}

function finishWithText(stream: AssistantMessageEventStream, text: string): void {
  const done = message('stop', { text })
  stream.push({ type: 'text_start', contentIndex: 0, partial: done })
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: done })
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: done })
  stream.push({ type: 'done', reason: 'stop', message: done })
  stream.end(done)
}

function finishWithError(stream: AssistantMessageEventStream, errorMessage: string): void {
  const failed = message('error', { errorMessage })
  stream.push({ type: 'error', reason: 'error', error: failed })
  stream.end(failed)
}

function okStream(text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  finishWithText(stream, text)
  return stream
}

function errorStream(errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  finishWithError(stream, errorMessage)
  return stream
}

type Handler = (
  model: Model<'test-api'>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

interface Attempt {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
}

function backend(id: string, model: Model<'test-api'>, handler: Handler): Provider<Api> {
  return createProvider<'test-api'>({
    id,
    name: id.toUpperCase(),
    auth: {
      apiKey: {
        name: 'key',
        async resolve() {
          return { auth: { apiKey: 'ambient-' + id }, source: 'test' }
        },
      },
    },
    models: [model],
    api: {
      stream: (receivedModel, _context, options) => handler(receivedModel as Model<'test-api'>, _context, options),
      streamSimple: (receivedModel, _context, options) => handler(receivedModel as Model<'test-api'>, _context, options),
    },
  })
}

function harness(
  handlers: { a: Handler; b: Handler },
  overrides: {
    missingProviders?: string[]
    isBackendConfigured?: (providerId: string) => boolean
    affinityKey?: string
    affinityKeyFn?: () => string
  } = {},
  options: {
    errorsBeforeSwitch?: number
    onFailover?: VirtualProviderDependencies['onFailover']
    deps?: Partial<VirtualProviderDependencies>
  } = {},
) {
  const attempts: Attempt[] = []
  const providers = new Map<string, Provider<Api>>([
    ['prov-a', backend('prov-a', modelA, (receivedModel, requestContext, options) => {
      const model = receivedModel as Model<'test-api'>
      attempts.push({
        provider: 'prov-a',
        model: model.id,
        ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        baseUrl: model.baseUrl,
      })
      return handlers.a(model, requestContext, options)
    })],
    ['prov-b', backend('prov-b', modelB, (receivedModel, requestContext, options) => {
      const model = receivedModel as Model<'test-api'>
      attempts.push({
        provider: 'prov-b',
        model: model.id,
        ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        baseUrl: model.baseUrl,
      })
      return handlers.b(model as Model<'test-api'>, requestContext, options)
    })],
  ])
  const service = new MultiProviderService({
    randomInt: () => 0,
    ...(options.errorsBeforeSwitch === undefined ? {} : { errorsBeforeSwitch: options.errorsBeforeSwitch }),
  })
  for (const integration of createVirtualIntegrations(config)) {
    service.registerProvider(integration)
  }
  const deps: VirtualProviderDependencies = {
    ...(options.deps ?? {}),
    service,
    config,
    ...(options.onFailover === undefined ? {} : { onFailover: options.onFailover }),
    getAffinityKey: () =>
      overrides.affinityKeyFn?.() ?? overrides.affinityKey ?? 'session-1',
    getBackingProvider: providerId =>
      overrides.missingProviders?.includes(providerId) ? undefined : providers.get(providerId),
    resolveAmbientAuth: async providerId => ({ ok: true, apiKey: 'ambient-' + providerId }),
    isBackendConfigured: overrides.isBackendConfigured ?? (() => true),
  }
  const virtual = createVirtualProvider(deps)
  return { service, virtual, attempts, deps }
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('virtual providers', () => {
  it('registers one unbiased scheduler per virtual model', async () => {
    const service = new MultiProviderService()
    for (const integration of createVirtualIntegrations(config)) {
      service.registerProvider(integration)
    }
    const snapshot = await service.snapshot()
    expect(snapshot.providers).toHaveLength(1)
    expect(snapshot.providers[0]?.id).toBe(virtualSchedulerId('pooled', 'ultra'))
    expect(snapshot.providers[0]?.firstAccountBias).toBe(false)
    expect(snapshot.providers[0]?.accounts.map(account => account.id))
      .toEqual(['prov-a::model-a', 'prov-b::model-b'])
  })

  it('exposes virtual models templated from the first healthy backend', () => {
    const { virtual } = harness({ a: () => okStream('x'), b: () => okStream('x') })
    const models = virtual.getModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'ultra',
      name: 'ultra',
      provider: 'pooled',
      api: 'test-api',
      baseUrl: 'https://a.invalid',
      contextWindow: 1_000,
    })
    // No reasoning backend -> the map is simply not advertised.
    expect(models[0]!.thinkingLevelMap).toBeUndefined()
  })

  it('falls back to the persisted backend template before backing providers register', () => {
    const virtual = createVirtualProvider({
      service: new MultiProviderService(),
      config: {
        id: 'pooled',
        label: 'Pooled',
        models: [{
          id: 'ultra',
          backends: [{
            providerId: 'prov-a',
            modelId: 'model-a',
            template: { ...captureVirtualModelTemplate(modelA), reasoning: true },
          }],
        }],
      },
      // Mirrors extension load: no backing provider is registered yet when pi
      // snapshots enabled/resumed-session models.
      getBackingProvider: () => undefined,
      getAffinityKey: () => 'session-1',
      resolveAmbientAuth: async () => ({ ok: true }),
    })
    expect(virtual.getModels()[0]).toMatchObject({
      id: 'ultra',
      provider: 'pooled',
      api: 'test-api',
      baseUrl: 'https://a.invalid',
      reasoning: true,
      // Single reasoning source: the identity map over the levels it supports
      // (off explicitly null on the source; minimal/low/medium/high pass).
      thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
      contextWindow: 1_000,
      maxTokens: 100,
    })
  })

  it('prefers the live backing model over the persisted template', () => {
    const virtual = createVirtualProvider({
      service: new MultiProviderService(),
      config: {
        id: 'pooled',
        label: 'Pooled',
        models: [{
          id: 'ultra',
          backends: [{
            providerId: 'prov-a',
            modelId: 'model-a',
            template: {
              ...captureVirtualModelTemplate(modelA),
              api: 'openai-completions',
              baseUrl: 'https://stored.invalid',
              reasoning: true,
              contextWindow: 5_000,
            },
          }],
        }],
      },
      getBackingProvider: providerId =>
        providerId === 'prov-a' ? backend('prov-a', modelA, () => okStream('x')) : undefined,
      getAffinityKey: () => 'session-1',
      resolveAmbientAuth: async () => ({ ok: true }),
    })
    expect(virtual.getModels()[0]).toMatchObject({
      api: 'test-api',
      baseUrl: 'https://a.invalid',
      reasoning: false,
      contextWindow: 1_000,
    })
    expect(virtual.getModels()[0]!.thinkingLevelMap).toBeUndefined()
  })

  it('ignores persisted templates on disabled backends', () => {
    const virtual = createVirtualProvider({
      service: new MultiProviderService(),
      config: {
        id: 'pooled',
        label: 'Pooled',
        models: [{
          id: 'ultra',
          backends: [
            { providerId: 'prov-a', modelId: 'model-a', enabled: false, template: { ...captureVirtualModelTemplate(modelA), reasoning: true } },
            { providerId: 'prov-b', modelId: 'model-b' },
          ],
        }],
      },
      getBackingProvider: () => undefined,
      getAffinityKey: () => 'session-1',
      resolveAmbientAuth: async () => ({ ok: true }),
    })
    const model = virtual.getModels()[0]!
    expect(model.reasoning).toBe(false)
    expect(model.thinkingLevelMap).toBeUndefined()
  })

  it('heals stored configs by filling missing templates from live backings', () => {
    const resolved = healVirtualTemplates(config, (providerId, modelId) =>
      providerId === 'prov-a' && modelId === 'model-a' ? captureVirtualModelTemplate(modelA) : undefined)
    expect(resolved).not.toBeUndefined()
    expect(resolved?.models[0]?.backends[0]?.template).toEqual(captureVirtualModelTemplate(modelA))
    expect(resolved?.models[0]?.backends[1]?.template).toBeUndefined()
    expect(healVirtualTemplates(config, () => undefined)).toBeUndefined()
  })

  it('round-robins backends across sessions and delegates with backing model and ambient auth', async () => {
    const { attempts, deps } = harness({
      a: () => okStream('from-a'),
      b: () => okStream('from-b'),
    })
    // One service, two sessions: the pool rotates while each session stays
    // pinned to its selected backend.
    const firstSession = createVirtualProvider({ ...deps, getAffinityKey: () => 'session-1' })
    const secondSession = createVirtualProvider({ ...deps, getAffinityKey: () => 'session-2' })
    const model = firstSession.getModels()[0]!
    const first = await collect(firstSession.stream(model, context))
    const second = await collect(secondSession.stream(model, context))
    expect(first.at(-1)).toMatchObject({ type: 'done' })
    expect(second.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-b'])
    expect(attempts.map(attempt => attempt.apiKey)).toEqual(['ambient-prov-a', 'ambient-prov-b'])
    expect(attempts.every(attempt => attempt.baseUrl?.startsWith('https://'))).toBe(true)
  })

  it('pins the session affinity key to the last healthy backend', async () => {
    const { virtual, attempts } = harness({
      a: () => okStream('from-a'),
      b: () => okStream('from-b'),
    })
    const model = virtual.getModels()[0]!
    await collect(virtual.stream(model, context))
    await collect(virtual.stream(model, context))
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-a'])
  })

  it('fails over to the next backend before output', async () => {
    const { virtual, attempts } = harness(
      { a: () => errorStream('HTTP 500 upstream'), b: () => okStream('from-b') },
      undefined,
      { errorsBeforeSwitch: 1 },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-b'])
  })

  it('fails over when a backend provider or model is unavailable', async () => {
    const { virtual, attempts } = harness(
      { a: () => okStream('from-a'), b: () => okStream('from-b') },
      { missingProviders: ['prov-a'] },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-b'])
  })

  it('replays the terminal error once every backend is exhausted', async () => {
    const { virtual, attempts } = harness(
      { a: () => errorStream('HTTP 500'), b: () => errorStream('HTTP 503') },
      undefined,
      { errorsBeforeSwitch: 1 },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(attempts).toHaveLength(2)
  })

  it('absorbs up to three backend errors before failing over', async () => {
    const { virtual, attempts } = harness({
      a: () => errorStream('HTTP 503'),
      b: () => okStream('from-b'),
    })
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-a', 'model-a', 'model-b'])
  })

  it('surfaces the buffered error when onFailover claims the transition', async () => {
    const hookCalls: FailoverInfo[] = []
    const { virtual, attempts } = harness(
      { a: () => errorStream('HTTP 500'), b: () => errorStream('HTTP 503') },
      {},
      {
        onFailover: info => {
          hookCalls.push(info)
          return true
        },
      },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(attempts.map(attempt => attempt.model)).toEqual(['model-a', 'model-a', 'model-a'])
    expect(hookCalls).toEqual([expect.objectContaining({
      providerId: virtualSchedulerId('pooled', 'ultra'),
      fromAccountId: 'prov-a::model-a',
      failure: expect.objectContaining({ message: 'HTTP 500', outputStarted: false }),
      errorsOnAccount: 3,
    })])
  })

  it('reports unconfigured auth when no backend provider is configured', async () => {
    const { virtual } = harness(
      { a: () => okStream('x'), b: () => okStream('x') },
      { isBackendConfigured: () => false },
    )
    await expect(
      virtual.auth.apiKey!.resolve({ ctx: authContext, signal: new AbortController().signal }),
    ).resolves.toBeUndefined()
  })

  it('attributes every yielded frame to the virtual model identity', async () => {
    const { virtual } = harness({ a: () => okStream('from-a'), b: () => okStream('from-b') })
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      if ('partial' in event) {
        expect(event.partial.provider).toBe('pooled')
        expect(event.partial.model).toBe('ultra')
      }
      if (event.type === 'done') {
        expect(event.message.provider).toBe('pooled')
        expect(event.message.model).toBe('ultra')
      }
    }
  })

  it('attributes failover frames to the virtual identity across backends', async () => {
    const { virtual } = harness(
      { a: () => errorStream('HTTP 500'), b: () => okStream('from-b') },
      undefined,
      { errorsBeforeSwitch: 1 },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    const done = events.at(-1)!
    if (done.type === 'done') {
      expect(done.message.provider).toBe('pooled')
      expect(done.message.model).toBe('ultra')
    }
    for (const event of events) {
      if ('partial' in event) {
        expect(event.partial.provider).toBe('pooled')
        expect(event.partial.model).toBe('ultra')
      }
    }
  })

  it('attributes replayed terminal errors to the virtual identity', async () => {
    const { virtual } = harness(
      { a: () => errorStream('HTTP 500'), b: () => errorStream('HTTP 503') },
      undefined,
      { errorsBeforeSwitch: 1 },
    )
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    const last = events.at(-1)!
    expect(last).toMatchObject({ type: 'error' })
    if (last.type === 'error') {
      expect(last.error.provider).toBe('pooled')
      expect(last.error.model).toBe('ultra')
    }
  })

  it('re-applies session-routing headers for the dispatched backend', async () => {
    // Mirrors the user-facing failure: a virtual model backed by opencode-go
    // must reach opencode.ai with x-opencode-session, even though pi core
    // computes those headers from the session model (the virtual identity).
    const opencodeModel: Model<'test-api'> = {
      ...modelA,
      id: 'glm-5.3-flash',
      name: 'GLM Flash',
      provider: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    }
    const config: VirtualProviderConfig = {
      id: 'pooled',
      label: 'Pooled',
      models: [{ id: 'ultra', backends: [{ providerId: 'opencode-go', modelId: opencodeModel.id }] }],
    }
    const service = new MultiProviderService({ randomInt: () => 0 })
    for (const integration of createVirtualIntegrations(config)) {
      service.registerProvider(integration)
    }
    const captured: Array<CapturedOptions | undefined> = []
    const virtual = createVirtualProvider({
      service,
      config,
      getAffinityKey: () => 'session-1',
      getBackingProvider: () =>
        backend('opencode-go', opencodeModel, (_m, _c, options) => {
          captured.push(options as CapturedOptions | undefined)
          return okStream('x')
        }),
      resolveAmbientAuth: async () => ({ ok: true, apiKey: 'ambient' }),
    })
    await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(captured[0]?.transformHeaders).toBeDefined()
    const headers = await captured[0]!.transformHeaders!({ 'user-agent': 'test' })
    expect(headers['x-opencode-session']).toBe('session-1')
    expect(headers['x-opencode-client']).toBe('pi')
    expect(headers['user-agent']).toBe('test')
  })

  it('leaves non-session-routing backends untouched', async () => {
    const config: VirtualProviderConfig = {
      id: 'pooled',
      label: 'Pooled',
      models: [{ id: 'ultra', backends: [{ providerId: 'prov-a', modelId: modelA.id }] }],
    }
    const service = new MultiProviderService({ randomInt: () => 0 })
    for (const integration of createVirtualIntegrations(config)) {
      service.registerProvider(integration)
    }
    const captured: Array<CapturedOptions | undefined> = []
    const virtual = createVirtualProvider({
      service,
      config,
      getAffinityKey: () => 'session-1',
      getBackingProvider: () =>
        backend('prov-a', modelA, (_m, _c, options) => {
          captured.push(options as CapturedOptions | undefined)
          return okStream('x')
        }),
      resolveAmbientAuth: async () => ({ ok: true, apiKey: 'ambient' }),
    })
    await collect(virtual.stream(virtual.getModels()[0]!, context))
    const headers = (await captured[0]!.transformHeaders!({})) ?? {}
    expect(headers['x-opencode-session']).toBeUndefined()
    expect(headers['x-opencode-client']).toBeUndefined()
  })

  it('never overrides session-routing headers set upstream', async () => {
    const opencodeModel: Model<'test-api'> = {
      ...modelA,
      id: 'glm-5.3-flash',
      provider: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    }
    const config: VirtualProviderConfig = {
      id: 'pooled',
      label: 'Pooled',
      models: [{ id: 'ultra', backends: [{ providerId: 'opencode-go', modelId: opencodeModel.id }] }],
    }
    const service = new MultiProviderService({ randomInt: () => 0 })
    for (const integration of createVirtualIntegrations(config)) {
      service.registerProvider(integration)
    }
    const captured: Array<CapturedOptions | undefined> = []
    const virtual = createVirtualProvider({
      service,
      config,
      getAffinityKey: () => 'session-1',
      getBackingProvider: () =>
        backend('opencode-go', opencodeModel, (_m, _c, options) => {
          captured.push(options as CapturedOptions | undefined)
          return okStream('x')
        }),
      resolveAmbientAuth: async () => ({ ok: true, apiKey: 'ambient' }),
    })
    await collect(virtual.stream(virtual.getModels()[0]!, context))
    const headers: ProviderHeaders = await captured[0]!.transformHeaders!({
      'x-opencode-session': 'pinned-elsewhere',
    })
    expect(headers['x-opencode-session']).toBe('pinned-elsewhere')
  })

  it('carries backend priority into the scheduler and honors the priority strategy', async () => {
    const config: VirtualProviderConfig = {
      id: 'pooled',
      label: 'Pooled',
      strategy: 'priority',
      models: [{
        id: 'ultra',
        backends: [
          { providerId: 'prov-a', modelId: 'model-a', priority: 5 },
          { providerId: 'prov-b', modelId: 'model-b' },
        ],
      }],
    }
    const service = new MultiProviderService({ randomInt: () => 0 })
    const integrations = createVirtualIntegrations(config)
    for (const integration of integrations) service.registerProvider(integration)
    // Mirrors refreshVirtual: the persisted strategy is applied to the pool
    // preference after registration.
    for (const integration of integrations) {
      await service.updatePool(integration.id, { policy: config.strategy ?? 'round-robin' })
    }
    const snapshot = await service.snapshot()
    expect(snapshot.providers[0]?.policy).toBe('priority')
    expect(snapshot.providers[0]?.accounts.map(account => account.priority)).toEqual([5, 0])
    const schedulerId = virtualSchedulerId('pooled', 'ultra')
    const first = await service.acquire({ providerId: schedulerId, affinityKey: 'session-1' })
    const second = await service.acquire({ providerId: schedulerId, affinityKey: 'session-2' })
    expect(first.accountId).toBe('prov-b::model-b')
    expect(second.accountId).toBe('prov-b::model-b')
    first.release({ status: 'success' })
    second.release({ status: 'success' })
  })

  it('reports placeholder auth once a backend is configured', async () => {
    const { virtual } = harness({ a: () => okStream('x'), b: () => okStream('x') })
    const resolution = await virtual.auth.apiKey!.resolve({
      ctx: authContext,
      signal: new AbortController().signal,
    })
    expect(resolution).toMatchObject({ auth: { apiKey: 'virtual-provider' }, source: 'virtual provider' })
  })

  it('advertises the thinking-level intersection across enabled backends', () => {
    const reasoningA: Model<'test-api'> = {
      ...modelA,
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    }
    const reasoningB: Model<'test-api'> = {
      ...modelB,
      reasoning: true,
      thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    }
    const virtual = createVirtualProvider({
      service: new MultiProviderService({ randomInt: () => 0 }),
      config: {
        id: 'pooled',
        label: 'Pooled',
        models: [{
          id: 'ultra',
          backends: [
            { providerId: 'prov-a', modelId: 'model-a' },
            { providerId: 'prov-b', modelId: 'model-b' },
          ],
        }],
      },
      getBackingProvider: providerId =>
        providerId === 'prov-a'
          ? backend('prov-a', reasoningA, () => okStream('x'))
          : backend('prov-b', reasoningB, () => okStream('x')),
      getAffinityKey: () => 'session-1',
      resolveAmbientAuth: async () => ({ ok: true }),
    })
    // Intersection of {low, high, max} and {low, medium, high}: low + high.
    expect(virtual.getModels()[0]!.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
    })
  })

  it('skips backends that cannot serve the requested thinking level', async () => {
    // prov-a's model only maps low/medium; a request at high must not reach it.
    const limitedA: Model<'test-api'> = {
      ...modelA,
      reasoning: true,
      thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: null },
    }
    const reasoningB: Model<'test-api'> = {
      ...modelB,
      reasoning: true,
      thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    }
    const httpAttempts: string[] = []
    const flagged: string[] = []
    const service = new MultiProviderService({ randomInt: () => 0 })
    for (const integration of createVirtualIntegrations(config)) service.registerProvider(integration)
    const virtual = createVirtualProvider({
      service,
      config,
      getAffinityKey: () => 'session-1',
      getBackingProvider: providerId =>
        providerId === 'prov-a'
          ? backend('prov-a', limitedA, model => { httpAttempts.push(model.provider + '/' + model.id); return okStream('from-a') })
          : backend('prov-b', reasoningB, model => { httpAttempts.push(model.provider + '/' + model.id); return okStream('from-b') }),
      resolveAmbientAuth: async () => ({ ok: true, apiKey: 'ambient' }),
      onBackendFatalMetadata: (providerId, modelId) => flagged.push(providerId + '/' + modelId),
    })
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context, { reasoningEffort: 'high' }))
    // prov-a/model-a cannot serve high: skipped without an HTTP attempt and
    // flagged; prov-b/model-b (reasoning true, high supported) serves.
    expect(httpAttempts).toEqual(['prov-b/model-b'])
    expect(flagged).toEqual(['prov-a/model-a'])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('allows non-reasoning backends to serve requests at any thinking level', async () => {
    const { virtual, attempts } = harness({ a: () => okStream('from-a'), b: () => okStream('x') })
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context, { reasoningEffort: 'high' }))
    expect(attempts.map(attempt => attempt.provider)).toEqual(['prov-a'])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('flags the provider on a quota failure and fails over, then skips it without HTTP', async () => {
    const blockedProviders = new Set<string>()
    let request = 0
    const { virtual, attempts } = harness(
      {
        // Session affinity pins request 1 to prov-a; its 402 on request 2
        // flags the whole provider so the failover lands on prov-b.
        a: () => {
          request += 1
          return request === 1
            ? okStream('from-a')
            : errorStream('402: {"message":"You are out of credits. Add more at https://hyper.charm.land"}')
        },
        b: () => okStream('from-b'),
      },
      {},
      {
        errorsBeforeSwitch: 1,
        deps: {
          isProviderBlocked: providerId => blockedProviders.has(providerId),
          onBackendQuotaFailure: providerId => { blockedProviders.add(providerId) },
        },
      },
    )
    // Request 1: prov-a serves and pins the session.
    let events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    // Request 2: prov-a 402s pre-output -> provider flagged -> failover to prov-b.
    events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(blockedProviders.has('prov-a')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    // Request 3: prov-a is quota-blocked -> skipped without an HTTP attempt.
    events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(blockedProviders.has('prov-a')).toBe(true)
    expect(attempts.filter(attempt => attempt.provider === 'prov-a')).toHaveLength(2)
    expect(attempts.filter(attempt => attempt.provider === 'prov-b')).toHaveLength(2)
    expect(attempts.at(-1)?.provider).toBe('prov-b')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('surfaces a clear error when every backend is quota-blocked', async () => {
    const blockedProviders = new Set(['prov-a', 'prov-b'])
    const { virtual, attempts } = harness(
      { a: () => okStream('x'), b: () => okStream('x') },
      {},
      {
        deps: {
          isProviderBlocked: providerId => blockedProviders.has(providerId),
        },
      },
    )
    // Terminal-error convention: the stream replays a clear quota-blocked
    // error event instead of throwing mid-iteration.
    const events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(attempts).toEqual([])
    const last = events.at(-1)!
    expect(last).toMatchObject({ type: 'error' })
    if (last.type === 'error') expect(last.error.errorMessage).toMatch(/quota-blocked/)
  })

  it('flags fatal metadata errors and skips the flagged pair afterwards', async () => {
    const flaggedPairs: string[] = []
    const flaggedSet = new Set<string>()
    let request = 0
    const { virtual, attempts } = harness(
      {
        // Session affinity pins request 1 to prov-a; its 400 invalid_request
        // on request 2 is fatal for the (provider, model) pair.
        a: () => {
          request += 1
          return request === 1
            ? okStream('from-a')
            : errorStream('400: {"type":"invalid_request_error","message":"native reasoning control reasoning_effort is not allowed"}')
        },
        b: () => okStream('from-b'),
      },
      {},
      {
        errorsBeforeSwitch: 1,
        deps: {
          isModelFlagged: (providerId, modelId) => flaggedSet.has(providerId + '/' + modelId),
          onBackendFatalMetadata: (providerId, modelId) => {
            flaggedSet.add(providerId + '/' + modelId)
            flaggedPairs.push(providerId + '/' + modelId)
          },
        },
      },
    )
    // Request 1: prov-a serves and pins the session.
    let events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    // Request 2: prov-a's 400 invalid_request is fatal for the pair -> surfaced.
    events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(flaggedSet.has('prov-a/model-a')).toBe(true)
    // Request 3: the flagged pair is skipped without an HTTP attempt.
    events = await collect(virtual.stream(virtual.getModels()[0]!, context))
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(attempts.filter(attempt => attempt.provider === 'prov-a')).toHaveLength(2)
    expect(attempts.at(-1)?.provider).toBe('prov-b')
    expect(flaggedPairs).toEqual(['prov-a/model-a'])
  })
})
