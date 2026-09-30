import {
  lazyStream,
  type Api,
  type ApiStreamOptions,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type ProviderHeaders,
  type ProviderResponse,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import {
  failureFrom,
  mergeHeaders,
  replayTerminal,
  type BufferedTerminal,
} from './lift.ts'
import { sessionAttributionHeaders } from './session-attribution.ts'
import { affinityScope } from './affinity-scope.ts'
import type { MultiProviderService } from './service.ts'
import { isFatalMetadataFailure, isQuotaFailure } from './quota.ts'
import {
  nearestThinkingLevel,
  resolveVirtualThinkingMap,
  supportedThinkingLevels,
  type ModelThinkingLevel,
  type ThinkingSource,
} from './thinking.ts'
import type {
  AccountLease,
  FailoverInfo,
  FailureDisposition,
  ProviderAttemptFailure,
  ProviderRegistration,
  SelectionBias,
  VirtualBackend,
  VirtualModelConfig,
  VirtualModelTemplate,
  VirtualProviderConfig,
} from './types.ts'

type StreamKind = 'stream' | 'streamSimple'
type RequestOptions = StreamOptions & Record<string, unknown>

// Pause between same-account retries so consecutive absorbed errors give a
// briefly rate-limited or recovering backend a chance to settle.
const SAME_ACCOUNT_RETRY_DELAY_MS = 250

// Virtual provider ids, virtual model ids, and provider/model ids must not
// contain this separator: it composes scheduler ids and backend account ids.
export const VIRTUAL_ID_SEPARATOR = '::'
export const BACKEND_UNAVAILABLE_PREFIX = 'multiprovider: virtual backend unavailable'
// A backend whose model metadata cannot serve the request (e.g. a thinking
// level it does not support, or an upstream that rejects the model's declared
// parameters). Retryable so the pool fails over; the extension flags the pair
// so later requests skip it without spending an attempt.
export const BACKEND_INCOMPATIBLE_PREFIX = 'multiprovider: virtual backend incompatible'
// The backing provider is quota-blocked until its billing reset; selecting it
// would only burn a scheduler attempt.
export const BACKEND_QUOTA_BLOCKED_PREFIX = 'multiprovider: virtual backend quota-blocked'

// Placeholder credential the virtual provider reports to the host so its
// models pass auth-availability checks; real auth resolves per attempt at the
// backing provider layer.
const VIRTUAL_PLACEHOLDER_API_KEY = 'virtual-provider'

export function virtualSchedulerId(virtualProviderId: string, modelId: string): string {
  return virtualProviderId + VIRTUAL_ID_SEPARATOR + modelId
}

export function virtualBackendAccountId(
  backend: Pick<VirtualBackend, 'providerId' | 'modelId'>,
): string {
  return backend.providerId + VIRTUAL_ID_SEPARATOR + backend.modelId
}

// Ambient (host-registered) auth for a backing provider, resolved per attempt.
// A failed resolution does not abort the attempt: backing providers with their
// own multiprovider pool resolve stored credentials themselves.
export type AmbientAuthResolution =
  | {
      ok: true
      apiKey?: string
      headers?: ProviderHeaders
      baseUrl?: string
      env?: Record<string, string>
    }
  | { ok: false; error: string }

export interface VirtualProviderDependencies {
  service: MultiProviderService
  config: VirtualProviderConfig
  getAffinityKey: () => string
  getBackingProvider: (providerId: string) => Provider<Api> | undefined
  resolveAmbientAuth: (
    providerId: string,
    model: Model<Api>,
    signal: AbortSignal,
  ) => Promise<AmbientAuthResolution>
  isBackendConfigured?: (providerId: string) => boolean
  maxAccountAttempts?: number
  onFailover?: (info: FailoverInfo) => boolean | void
  // Provider-level quota blocking (see src/quota.ts): blocked providers are
  // skipped without an HTTP attempt until their billing reset.
  isProviderBlocked?: (providerId: string) => boolean
  onBackendQuotaFailure?: (providerId: string, failure: ProviderAttemptFailure) => void
  // Per-(provider, model) incompatibility flags for permanent metadata
  // rejections; flagged pairs are skipped for the rest of the process.
  // A pair is flagged only for the level that was actually rejected (undefined
  // = it rejected reasoning control with no level in play, so no level works).
  isModelFlagged?: (providerId: string, modelId: string, level: ModelThinkingLevel | undefined) => boolean
  onBackendFatalMetadata?: (
    providerId: string,
    modelId: string,
    level: ModelThinkingLevel | undefined,
    failure: ProviderAttemptFailure,
  ) => void
  // Names the backend a request was dispatched to, so a host can show which
  // provider is actually serving the session. Fires at dispatch time: a
  // failover re-reports with the backend that takes over.
  onBackendServed?: (info: VirtualServedInfo) => void
}

// Which virtual model a session selected, and which backing provider/model
// the scheduler dispatched it to.
export interface VirtualServedInfo {
  virtualProviderId: string
  virtualModelId: string
  providerId: string
  modelId: string
  /** Thinking level the session asked for, when it asked for one. */
  requestedLevel?: ModelThinkingLevel
  /** The level actually sent: equal unless the backend could not serve it. */
  servedLevel?: ModelThinkingLevel
}

export interface VirtualIntegrationOptions {
  getProviderLabel?: (providerId: string) => string | undefined
  maxAccountAttempts?: number
}

// One scheduler registration per virtual model: each model's backends pool
// independently, and every virtual pool rotates with selectionBias 'none' so
// sessions spread evenly across providers (no first-provider favoritism).
export function createVirtualIntegrations(
  config: VirtualProviderConfig,
  options: VirtualIntegrationOptions = {},
): ProviderRegistration<VirtualBackend>[] {
  return config.models.map(model => ({
    id: virtualSchedulerId(config.id, model.id),
    label: config.label + ' · ' + (model.label ?? model.id),
    selectionBias: 'none' as SelectionBias,
    accounts: () =>
      model.backends
        .filter(backend => backend.enabled !== false)
        .map(backend => ({
          id: virtualBackendAccountId(backend),
          label: (options.getProviderLabel?.(backend.providerId) ?? backend.providerId) + ' · ' + backend.modelId,
          authKind: 'custom' as const,
          credentialRef: backend,
          weight: backend.weight ?? 1,
          priority: backend.priority ?? 0,
          metadata: { virtual: true, providerId: backend.providerId, modelId: backend.modelId },
        })),
    classifyFailure: (failure: ProviderAttemptFailure) => {
      const message = failure.message.toLowerCase()
      if (
        failure.message.startsWith(BACKEND_UNAVAILABLE_PREFIX)
        || /fetch failed|network|econn(?:aborted|refused|reset)|enotfound|etimedout|socket hang up|not configured/.test(message)
      ) {
        return { kind: 'transient' as const, retryable: true }
      }
      if (failure.message.startsWith(BACKEND_INCOMPATIBLE_PREFIX)) {
        return { kind: 'fatal' as const, retryable: true }
      }
      if (failure.message.startsWith(BACKEND_QUOTA_BLOCKED_PREFIX)) {
        // The provider-level registry governs the duration; no scheduler
        // cooldown on top of it.
        return { kind: 'quota' as const, retryable: true, cooldownMs: 0 }
      }
      return undefined
    },
    ...(options.maxAccountAttempts === undefined ? {} : { maxAccountAttempts: options.maxAccountAttempts }),
  }))
}

function resolveTarget(
  dependencies: VirtualProviderDependencies,
  backend: VirtualBackend,
): { provider: Provider<Api>; model: Model<Api> } | string {
  const provider = dependencies.getBackingProvider(backend.providerId)
  if (provider === undefined) {
    return BACKEND_UNAVAILABLE_PREFIX + ': provider "' + backend.providerId + '" is not registered'
  }
  const model = provider.getModels().find(candidate => candidate.id === backend.modelId)
  if (model === undefined) {
    return BACKEND_UNAVAILABLE_PREFIX + ': provider "' + backend.providerId + '" has no model "' + backend.modelId + '"'
  }
  return { provider, model }
}

// Pre-flight rejections that must not spend an HTTP attempt: a provider under
// a quota block, or a (provider, model) pair already flagged incompatible.
function skipFailureFor(
  dependencies: VirtualProviderDependencies,
  backend: VirtualBackend,
): ProviderAttemptFailure | undefined {
  if (dependencies.isProviderBlocked?.(backend.providerId) === true) {
    return {
      message: BACKEND_QUOTA_BLOCKED_PREFIX + ': provider "' + backend.providerId
        + '" is blocked until its quota reset',
      outputStarted: false,
    }
  }
  return undefined
}

// Skip a pair this session already saw reject the exact level about to be
// sent. Selection is never filtered by advertised thinking support — only by a
// proven rejection at that level, which is the one thing a retry cannot fix.
function flagFailureFor(
  dependencies: VirtualProviderDependencies,
  backend: VirtualBackend,
  level: ModelThinkingLevel | undefined,
): ProviderAttemptFailure | undefined {
  if (dependencies.isModelFlagged?.(backend.providerId, backend.modelId, level) !== true) return undefined
  return {
    message: BACKEND_INCOMPATIBLE_PREFIX + ': "' + backend.providerId + '/' + backend.modelId
      + (level === undefined ? '" was rejected' : '" at level "' + level + '" was rejected')
      + ' earlier in this session',
    outputStarted: false,
  }
}

function virtualStream<TApi extends Api>(
  dependencies: VirtualProviderDependencies,
  kind: StreamKind,
  model: Model<TApi>,
  context: TranscriptContext,
  options?: RequestOptions,
): AssistantMessageEventStream {
  const { config, service } = dependencies
  return lazyStream(model, async () => {
    const requestOptions = { ...(options ?? {}) } as RequestOptions
    const signal = requestOptions.signal ?? new AbortController().signal
    const schedulerId = virtualSchedulerId(config.id, model.id)
    // Stickiness itself stays the scheduler's call (pool.affinity decides
    // whether an implicit pin applies, while an explicit /switch-account pin
    // always does); this only decides *whose* identity is used as the key.
    const affinityKey = affinityScope(
      requestOptions,
      dependencies.getAffinityKey(),
    )
    const attempted = new Set<string>()
    const maxAttempts = dependencies.maxAccountAttempts ?? Number.MAX_SAFE_INTEGER
    const errorsBeforeSwitch = service.getErrorsBeforeSwitch()
    let attempts = 0
    let lastTerminal: BufferedTerminal | undefined
    let lastSetupError: unknown

    // Stable identity: the host selected the virtual model, so every yielded
    // assistant frame must attribute to the virtual provider/model — not the
    // backing provider that happened to serve the attempt. Consumers compare
    // this attribution against the selected model (session transcript, resume,
    // pi-fabric's model drift guard) and treating a mismatch as drift.
    const attributeEvent = (event: AssistantMessageEvent): AssistantMessageEvent => {
      const identity = { provider: config.id, model: model.id }
      if ('partial' in event) return { ...event, partial: { ...event.partial, ...identity } }
      if (event.type === 'done') return { ...event, message: { ...event.message, ...identity } }
      if (event.type === 'error') return { ...event, error: { ...event.error, ...identity } }
      return event
    }

    const attemptsStream = (async function* (): AsyncGenerator<AssistantMessageEvent> {
      while (attempts < maxAttempts) {
        let lease: AccountLease<VirtualBackend>
        try {
          lease = await service.acquire<VirtualBackend>({
            providerId: schedulerId,
            ...(affinityKey === undefined ? {} : { affinityKey }),
            excludeAccountIds: attempted,
          })
        } catch (error) {
          if (lastTerminal !== undefined) {
            yield* replayTerminal(lastTerminal)
            return
          }
          throw lastSetupError ?? error
        }

        attempts += 1
        attempted.add(lease.accountId)
        const backend = lease.credentialRef
        let settled = false
        let outputStarted = false
        let start: BufferedTerminal['start']
        let response: ProviderResponse | undefined
        // The thinking level this attempt actually sends, once the backend's own
        // support is resolved. A rejection is attributed to exactly this level.
        let sentLevel: ModelThinkingLevel | undefined
        // Per-lease outcome once the backend is abandoned: 'next-account'
        // rotates to the next backend inline; 'surface' ends the stream with
        // the buffered error so an external failover handler (e.g.
        // compact-then-retry) can re-enter the pool with fresh context.
        let leaseOutcome: 'next-account' | 'surface' | undefined
        let sameAccountErrors = 0

        const skipFailure = skipFailureFor(dependencies, backend)
        if (skipFailure !== undefined) {
          lastSetupError = new Error(skipFailure.message)
          const disposition = lease.release({ status: 'failure', error: skipFailure })
          settled = true
          if (disposition?.retryable && attempts < maxAttempts && !signal.aborted) continue
          throw lastSetupError
        }

        // Central failure release: feeds the provider-level quota registry and
        // the per-model incompatibility flags before failover continues.
        const releaseFailure = (failure: ProviderAttemptFailure): FailureDisposition | undefined => {
          const disposition = lease.release({ status: 'failure', error: failure })
          if (disposition?.kind === 'quota' || isQuotaFailure(failure)) {
            dependencies.onBackendQuotaFailure?.(backend.providerId, failure)
          } else if (disposition?.kind === 'fatal' && isFatalMetadataFailure(failure)) {
            dependencies.onBackendFatalMetadata?.(backend.providerId, backend.modelId, sentLevel, failure)
          }
          return disposition
        }

        try {
          const target = resolveTarget(dependencies, backend)
          if (typeof target === 'string') {
            lastSetupError = new Error(target)
            const disposition = releaseFailure({ message: target, outputStarted: false })
            settled = true
            if (disposition?.retryable && attempts < maxAttempts && !signal.aborted) continue
            throw lastSetupError
          }

          // Thinking level never filters which backend serves a request: the
          // pool's strategy picks any backend and this request's level degrades
          // to the nearest one that backend actually supports. 'off' and
          // non-reasoning models are passed through exactly as the host asked —
          // inventing a thinking level is not ours to do.
          const requestedLevel = typeof requestOptions.reasoningEffort === 'string'
            && requestOptions.reasoningEffort !== 'off'
            ? requestOptions.reasoningEffort as ModelThinkingLevel
            : undefined
          const servedLevel = requestedLevel === undefined || !target.model.reasoning
            ? requestedLevel
            : nearestThinkingLevel(target.model, requestedLevel)
          sentLevel = servedLevel

          // The one case that still removes a backend: this pair already
          // rejected this exact level earlier in the session.
          const flagged = flagFailureFor(dependencies, backend, servedLevel)
          if (flagged !== undefined) {
            lastSetupError = new Error(flagged.message)
            const disposition = lease.release({ status: 'failure', error: flagged })
            settled = true
            if (disposition?.retryable && attempts < maxAttempts && !signal.aborted) continue
            throw lastSetupError
          }

          const ambient = await dependencies.resolveAmbientAuth(backend.providerId, target.model, signal)
          const attemptOptions = { ...requestOptions } as RequestOptions
          if (servedLevel !== undefined && servedLevel !== requestedLevel) {
            attemptOptions.reasoningEffort = servedLevel
          }
          // The host resolves auth for the virtual provider itself (a
          // placeholder key); backing auth comes from the ambient layer below
          // or from the backing provider's own integration.
          delete attemptOptions.apiKey
          if (ambient.ok) {
            if (ambient.apiKey !== undefined) attemptOptions.apiKey = ambient.apiKey
            const headers = mergeHeaders(requestOptions.headers, ambient.headers)
            if (headers !== undefined) attemptOptions.headers = headers
            const env = ambient.env === undefined && requestOptions.env === undefined
              ? undefined
              : { ...(requestOptions.env ?? {}), ...(ambient.env ?? {}) }
            if (env !== undefined) attemptOptions.env = env
          }
          const streamModel: Model<Api> = ambient.ok && ambient.baseUrl !== undefined
            ? { ...target.model, baseUrl: ambient.baseUrl }
            : target.model
          const onResponse = attemptOptions.onResponse
          attemptOptions.onResponse = async (nextResponse, responseModel) => {
            response = {
              status: nextResponse.status,
              headers: { ...nextResponse.headers },
            }
            await onResponse?.(nextResponse, responseModel)
          }
          attemptOptions.maxRetries = 0

          // Session-routing headers: pi core attributes them from the session
          // model — the virtual identity here — so a backend dispatched by the
          // virtual stream would miss them (opencode.ai rejects such requests
          // with 400 MissingSessionID). Re-apply them for the model actually
          // dispatched, filling only what the core pipeline and provider hooks
          // left unset. The identity is the requesting session: the nested
          // agent's own when it declares one, else the host session.
          type HeaderTransform = (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>
          const innerTransformHeaders = attemptOptions.transformHeaders as HeaderTransform | undefined
          attemptOptions.transformHeaders = async (requestHeaders: ProviderHeaders) => {
            const attributed = (await innerTransformHeaders?.(requestHeaders)) ?? requestHeaders
            const enriched: ProviderHeaders = { ...attributed }
            for (const [name, value] of Object.entries(
              sessionAttributionHeaders(streamModel, affinityKey),
            )) {
              if (enriched[name] === undefined || enriched[name] === null) enriched[name] = value
            }
            return enriched
          }

          // Report the backend before streaming so a status surface learns who
          // is serving as the turn starts, not after it completes.
          dependencies.onBackendServed?.({
            virtualProviderId: config.id,
            virtualModelId: model.id,
            providerId: backend.providerId,
            modelId: backend.modelId,
            ...(requestedLevel === undefined ? {} : { requestedLevel }),
            ...(servedLevel === undefined ? {} : { servedLevel }),
          })

          // Same-account tolerance: pre-output retryable errors are absorbed
          // on the current backend until errorsBeforeSwitch is reached, so a
          // transient blip does not pay a cold-cache failover.
          while (leaseOutcome === undefined) {
            response = undefined
            start = undefined
            const inner = kind === 'streamSimple'
              ? target.provider.streamSimple(streamModel, context, attemptOptions as SimpleStreamOptions)
              : target.provider.stream(streamModel, context, attemptOptions as ApiStreamOptions<Api>)

            let retriedSameAccount = false
            for await (const raw of inner) {
              const event = attributeEvent(raw)
              if (event.type === 'start') {
                start = event
                continue
              }

              if (event.type === 'error') {
                if (event.reason === 'aborted' || signal.aborted) {
                  lease.release({ status: 'cancelled' })
                  settled = true
                } else {
                  const failure = failureFrom(undefined, response, outputStarted, event.error)
                  if (!outputStarted && sameAccountErrors + 1 < errorsBeforeSwitch) {
                    sameAccountErrors += 1
                    await new Promise(resolve => { setTimeout(resolve, SAME_ACCOUNT_RETRY_DELAY_MS) })
                    if (signal.aborted) {
                      lease.release({ status: 'cancelled' })
                      settled = true
                      return
                    }
                    retriedSameAccount = true
                    break
                  }
                  const disposition = releaseFailure(failure)
                  settled = true
                  if (!outputStarted && disposition?.retryable && attempts < maxAttempts) {
                    lastTerminal = {
                      ...(start === undefined ? {} : { start }),
                      event,
                    }
                    leaseOutcome = dependencies.onFailover?.({
                      providerId: schedulerId,
                      fromAccountId: lease.accountId,
                      failure,
                      errorsOnAccount: sameAccountErrors + 1,
                    }) === true
                      ? 'surface'
                      : 'next-account'
                    break
                  }
                }

                if (!outputStarted && start !== undefined) yield start
                yield event
                return
              }

              if (event.type === 'done') {
                lease.release({ status: 'success' })
                settled = true
                if (!outputStarted && start !== undefined) yield start
                yield event
                return
              }

              if (!outputStarted) {
                outputStarted = true
                if (start !== undefined) yield start
              }
              yield event
            }

            if (!retriedSameAccount) break
          }

          if (leaseOutcome === 'next-account') continue

          if (!settled) {
            const error = new Error('Provider stream ended without a terminal event')
            lastSetupError = error
            const disposition = releaseFailure(failureFrom(error, response, outputStarted))
            settled = true
            if (!outputStarted && disposition?.retryable && attempts < maxAttempts) continue
            throw error
          }
        } catch (error) {
          if (!settled) {
            const disposition = signal.aborted
              ? lease.release({ status: 'cancelled' })
              : releaseFailure(failureFrom(error, response, outputStarted))
            settled = true
            if (!outputStarted && disposition?.retryable && attempts < maxAttempts) {
              lastSetupError = error
              continue
            }
          }
          throw error
        } finally {
          if (!settled) lease.release({ status: 'cancelled' })
        }

        if (leaseOutcome === 'surface') break
      }

      if (lastTerminal !== undefined) {
        yield* replayTerminal(lastTerminal)
        return
      }
      throw lastSetupError ?? new Error('multiprovider: exhausted virtual backends for "' + config.id + '"')
    })()

    return attemptsStream
  })
}

// Snapshot the host-facing metadata a virtual model must advertise so pi can
// clamp thinking levels and size context before the backing provider
// registers (pi snapshots enabled/resumed-session models right after
// extension load).
export function captureVirtualModelTemplate(model: Model<Api>): VirtualModelTemplate {
  return {
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
    ...(model.compat === undefined
      ? {}
      : { compat: structuredClone(model.compat) as Model<Api>['compat'] }),
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }
}

// Bring persisted templates up to date from live backing models: fills in
// templates captured before this feature existed, and refreshes fields an
// older template predates (currently `compat`). Returns a cloned config when
// anything changed, else undefined — callers persist the healed config so the
// next extension load snapshots virtual models with correct thinking and
// request-shaping metadata without waiting for an editor save.
export function healVirtualTemplates(
  config: VirtualProviderConfig,
  resolveTemplate: (providerId: string, modelId: string) => VirtualModelTemplate | undefined,
): VirtualProviderConfig | undefined {
  let healed = false
  const models = config.models.map(model => ({
    ...model,
    backends: model.backends.map(backend => {
      if (backend.enabled === false) return backend
      const live = resolveTemplate(backend.providerId, backend.modelId)
      if (live === undefined) return backend
      if (backend.template === undefined) {
        healed = true
        return { ...backend, template: live }
      }
      if (backend.template.compat !== undefined || live.compat === undefined) return backend
      healed = true
      return { ...backend, template: { ...backend.template, compat: live.compat } }
    }),
  }))
  return healed ? { ...config, models } : undefined
}

export function createVirtualProvider(dependencies: VirtualProviderDependencies): Provider<Api> {
  const { config } = dependencies

  const virtualModel = (model: VirtualModelConfig): Model<Api> => {
    const sources: (Model<Api> | VirtualModelTemplate)[] = []
    for (const backend of model.backends) {
      if (backend.enabled === false) continue
      const candidate = dependencies
        .getBackingProvider(backend.providerId)
        ?.getModels()
        .find(item => item.id === backend.modelId)
      const source = candidate ?? backend.template
      if (source !== undefined) sources.push(source)
    }
    // Live backings win. Before they register (extension load, when pi already
    // snapshots enabled/resumed-session models), fall back to the templates
    // captured at backend-pick time so thinking support and context metadata
    // do not depend on provider registration order.
    const source = sources[0]
    // The advertised thinking map is the intersection across ALL enabled
    // backends, resolved in the operator's preference order (high > medium >
    // xhigh > low > max): pi clamps its default level against this map, so a
    // single-backend copy would let requests reach backends that reject the
    // level outright.
    const thinkingLevelMap = resolveVirtualThinkingMap(sources)
    return {
      id: model.id,
      name: model.label ?? model.id,
      api: source?.api ?? 'openai-completions',
      provider: config.id,
      baseUrl: source?.baseUrl ?? '',
      reasoning: sources.some(item => item.reasoning),
      ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      // Request-shaping flags follow the same source as api/baseUrl: a
      // consumer that dispatches the virtual model directly must build the
      // same payload the backing provider would, or e.g. a provider that
      // rejects native reasoning control gets sent reasoning_effort anyway.
      ...(source?.compat === undefined ? {} : { compat: source.compat }),
      input: source?.input ?? ['text'],
      cost: source?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: source?.contextWindow ?? 128_000,
      maxTokens: source?.maxTokens ?? 8_192,
    }
  }

  const provider: Provider<Api> = {
    id: config.id,
    name: config.label,
    auth: {
      apiKey: {
        name: config.label + ' (virtual)',
        async resolve() {
          const backends = config.models
            .flatMap(model => model.backends)
            .filter(backend => backend.enabled !== false)
          if (backends.length === 0) return undefined
          const configured = backends.some(backend =>
            dependencies.isBackendConfigured?.(backend.providerId) ?? true)
          if (!configured) return undefined
          return { auth: { apiKey: VIRTUAL_PLACEHOLDER_API_KEY }, source: 'virtual provider' }
        },
      },
    },
    getModels: () => config.models.map(virtualModel),
    stream<T extends Api>(
      model: Model<T>,
      context: TranscriptContext,
      streamOptions?: ApiStreamOptions<T>,
    ): AssistantMessageEventStream {
      return virtualStream(dependencies, 'stream', model, context, streamOptions as RequestOptions | undefined)
    },
    streamSimple(
      model: Model<Api>,
      context: TranscriptContext,
      streamOptions?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      return virtualStream(dependencies, 'streamSimple', model, context, streamOptions as RequestOptions | undefined)
    },
  }
  return provider
}
