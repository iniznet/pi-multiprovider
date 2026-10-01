import type {
  Api,
  AssistantMessage,
  AuthResult,
  Model,
  Provider,
  ProviderAuth,
  StreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

export type AuthKind = 'api-key' | 'oauth' | 'service-account' | 'custom'
export type SelectionPolicy = 'round-robin' | 'weighted-round-robin' | 'least-inflight' | 'priority'
export const SELECTION_POLICIES: readonly SelectionPolicy[] = [
  'round-robin',
  'weighted-round-robin',
  'least-inflight',
  'priority',
]
export type FailureKind = 'rate-limit' | 'quota' | 'auth' | 'transient' | 'fatal'

// How plain round-robin breaks ties when no session pin exists. 'first-account'
// always starts at the first healthy account in pool order (the "main"
// account) and only spills over while earlier accounts are unavailable;
// 'none' rotates evenly across accounts.
export type SelectionBias = 'first-account' | 'none'

export interface ProviderAttemptFailure {
  message: string
  status?: number
  headers?: Readonly<Record<string, string>>
  assistantMessage?: AssistantMessage
  cause?: unknown
  outputStarted: boolean
}

export interface ProviderAccount<TCredentialRef = unknown> {
  id: string
  label: string
  authKind: AuthKind
  credentialRef: TCredentialRef
  enabled?: boolean
  weight?: number
  priority?: number
  /**
   * Stage-one bucket key for two-level selection. Backends that live on the
   * same backing provider share a group, so a provider-level strategy can
   * spread load across providers before a model-level strategy chooses which
   * model on the chosen provider serves the request.
   */
  group?: string
  /**
   * Soft cap on simultaneous leases. Selection prefers accounts below the cap
   * and falls back to the least loaded account once every eligible account is
   * at it, so a cap steers concurrency rather than refusing requests.
   */
  maxConcurrent?: number
  metadata?: Readonly<Record<string, string | number | boolean | null>>
}

export interface FailureDisposition {
  kind: FailureKind
  retryable: boolean
  cooldownMs?: number
}

export interface ProviderRegistration<TCredentialRef = unknown> {
  id: string
  label: string
  accounts: () => readonly ProviderAccount<TCredentialRef>[] | Promise<readonly ProviderAccount<TCredentialRef>[]>
  classifyFailure?: (
    failure: ProviderAttemptFailure,
    account: ProviderAccount<TCredentialRef>,
  ) => FailureDisposition | undefined
  managementHint?: string
  selectionBias?: SelectionBias
}

export interface AccountPreference {
  accountId: string
  enabled: boolean
  weight: number
  priority: number
  maxConcurrent?: number
}

export interface PoolPreference {
  providerId: string
  policy: SelectionPolicy
  /**
   * Provider-level strategy for two-level selection. Absent means one flat
   * pass over the pool with `policy`, which is how every pool predating group
   * selection behaves.
   */
  groupPolicy?: SelectionPolicy
  /**
   * Provider-wide ceiling on simultaneous leases, keyed by group (the backing
   * provider id). A filter on eligibility rather than an ordering: it applies
   * whether the pool runs two-level selection or one flat pass. Counts are
   * per-process, so several pi processes on one pool each hold their own budget.
   */
  groupLimits?: Record<string, number>
  /**
   * Explicit provider ranks keyed by group, used by the priority strategy
   * instead of the minimum member priority. Without it a provider inherits the
   * best tier among its models, so adding one backend at the default priority
   0 silently promotes that provider into the first tier.
   */
  groupPriorities?: Record<string, number>
  affinity: boolean
  accounts: AccountPreference[]
}

// A session's pinned account. Explicit pins are set through pinAccount() and
// override the pool's affinity setting until cleared; implicit pins are the
// scheduler's own stickiness while pool affinity is enabled.
export interface AffinityPin {
  accountId: string
  explicit: boolean
}

// One recorded session-to-account attachment, for surfaces that show who is
// already served by an account before an operator picks another one.
export interface AffinityEntry extends AffinityPin {
  key: string
}

// A session's attachment mirrored into the shared store. Scheduler affinity is
// in-memory and per process: another terminal tab, or this tab after a reload,
// cannot see it. The registry is the only cross-process view of who is serving
// what, which is what a picker needs before landing a new agent somewhere.
export interface SessionAttachment {
  accountId: string
  /** Account label, so a viewer without this pool loaded can still name it. */
  label?: string
  /** True when set by an explicit switch rather than by session affinity. */
  explicit: boolean
  /** Epoch ms of the last dispatch that confirmed this attachment. */
  updatedAt: number
}

export interface SessionAttachmentEntry extends SessionAttachment {
  poolId: string
  key: string
}

// pi keeps no cross-process liveness signal, so freshness is the only proxy for
// "still open": a session that has not dispatched for this long is treated as
// gone and simply re-registers on its next request.
export const SESSION_ATTACHMENT_TTL_MS = 30 * 60_000

// Re-mirror an unchanged attachment at most this often: keeps a long-lived
// session's row alive without one store write per turn.
export const SESSION_ATTACHMENT_REFRESH_MS = 5 * 60_000

// Bound on stored sessions per pool, newest first, so a busy machine cannot
// grow the shared file without limit.
export const SESSION_ATTACHMENTS_PER_POOL_LIMIT = 64

export interface AcquireOptions {
  providerId: string
  affinityKey?: string
  excludeAccountIds?: Iterable<string>
}

export interface LeaseOutcomeSuccess { status: 'success' }
export interface LeaseOutcomeFailure { status: 'failure'; error: ProviderAttemptFailure }
export interface LeaseOutcomeCancelled { status: 'cancelled' }
export type LeaseOutcome = LeaseOutcomeSuccess | LeaseOutcomeFailure | LeaseOutcomeCancelled

export interface AccountLease<TCredentialRef = unknown> {
  readonly id: string
  readonly providerId: string
  readonly accountId: string
  readonly account: ProviderAccount<TCredentialRef>
  readonly credentialRef: TCredentialRef
  readonly acquiredAt: number
  release(outcome?: LeaseOutcome): FailureDisposition | undefined
}

export type PublicAccountStatus = 'ready' | 'cooldown' | 'disabled'

export interface PublicAccountSnapshot {
  id: string
  label: string
  authKind: AuthKind
  enabled: boolean
  weight: number
  priority: number
  status: PublicAccountStatus
  inFlight: number
  group?: string
  maxConcurrent?: number
  consecutiveFailures: number
  cooldownUntil?: number
  lastSelectedAt?: number
  lastFailureKind?: FailureKind
  metadata: Readonly<Record<string, string | number | boolean | null>>
}

export interface PublicPoolSnapshot {
  id: string
  label: string
  policy: SelectionPolicy
  groupPolicy?: SelectionPolicy
  groupLimits?: Record<string, number>
  affinity: boolean
  firstAccountBias: boolean
  managementHint?: string
  accounts: PublicAccountSnapshot[]
}

export interface MultiProviderSnapshot { providers: PublicPoolSnapshot[] }

/**
 * Fired when a pooled account is abandoned after its final tolerated error
 * and the stream is about to move to another account. Returning true tells
 * the stream to surface the buffered error instead of rotating accounts
 * inline — an external handler (e.g. compact-then-retry) will re-enter the
 * pool with fresh context.
 */
export interface FailoverInfo {
  providerId: string
  fromAccountId: string
  failure: ProviderAttemptFailure
  errorsOnAccount: number
}

export interface SchedulerSettings {
  rateLimitCooldownMs?: number
  quotaCooldownMs?: number
  authCooldownMs?: number
  transientBaseCooldownMs?: number
  maxCooldownMs?: number
  // Pre-output retryable errors absorbed on the same account before the
  // scheduler fails over to the next account. 1 reproduces the original
  // switch-on-first-error behavior.
  errorsBeforeSwitch?: number
}

// Patch form of SchedulerSettings where an explicitly undefined key clears
// the stored override under exactOptionalPropertyTypes.
export type SchedulerSettingsPatch = {
  [K in keyof SchedulerSettings]?: SchedulerSettings[K] | undefined
}

// Host-facing metadata snapshot of a backing model, captured when the backend
// is picked in /vprovider. Virtual models fall back to it while the backing
// provider is not registered yet — pi snapshots enabled/resumed-session
// models right after extension load, so thinking-level support and context
// metadata must not depend on provider registration order.
export interface VirtualModelTemplate {
  api: Model<Api>['api']
  baseUrl: string
  reasoning: boolean
  thinkingLevelMap?: Model<Api>['thinkingLevelMap']
  // Provider request-shaping flags (supportsReasoningEffort, thinkingFormat,
  // maxTokensField, ...). Without them the virtual model would let pi-ai
  // auto-detect compat from the virtual provider id instead of the backing
  // provider's, so a payload through the alias could differ from a direct call
  // to the same model.
  compat?: Model<Api>['compat']
  input: Model<Api>['input']
  cost: Model<Api>['cost']
  contextWindow: number
  maxTokens: number
}

// One backing (provider, model) pair inside a virtual provider. Virtual
// backends are scheduler accounts; the credentialRef carries the pair.
export interface VirtualBackend {
  providerId: string
  modelId: string
  enabled?: boolean
  weight?: number
  /** Failover order under the priority strategy: smaller numbers run first. */
  priority?: number
  /**
   * Soft cap on how many requests this backing model serves at once. Providers
   * commonly limit concurrency per model, so the cap belongs on the backend
   * rather than on the pool that spans several of them.
   */
  maxConcurrent?: number
  template?: VirtualModelTemplate
}

export interface VirtualModelConfig {
  id: string
  label?: string
  backends: VirtualBackend[]
}

// A virtual provider maps one virtual model (or several) to backing provider
// models while keeping per-session cache affinity. The pool strategy defaults
// to round-robin with unbiased rotation (selectionBias 'none'), and can be
// changed to any pool strategy; it is persisted with the config.
export interface VirtualProviderConfig {
  id: string
  label: string
  // Model-level strategy: which backend model serves once a provider is chosen
  // (or across every backend at once, when providerStrategy is absent).
  strategy?: SelectionPolicy
  /**
   * Provider-level strategy for two-level selection. Absent keeps one flat pass
   * over backends; set it to spread load across backing providers first, which
   * is what a provider with a per-model concurrency limit needs.
   */
  providerStrategy?: SelectionPolicy
  /**
   * Explicit provider ranks keyed by provider id, smaller running first. The
   * /vprovider ordering list writes this; leave it absent to keep deriving each
   * provider's rank from its best backend.
   */
  providerPriority?: Record<string, number>
  // Session stickiness across this pool's backends. Default true, matching
  // account pools. Turn it off when a fan-out host (subagents, workflows)
  // should spread across backends instead of reusing one per session.
  affinity?: boolean
  models: VirtualModelConfig[]
}

// How a backing provider replenishes the quota that a 402/429 exhausts. The
// operator marks each provider with its billing reality; the scheduler uses
// the kind to compute when a quota-blocked provider becomes usable again.
export type BillingResetKind = 'daily' | 'weekly' | 'monthly' | 'hours'
export const BILLING_RESET_KINDS: readonly BillingResetKind[] = [
  'daily',
  'weekly',
  'monthly',
  'hours',
]

export interface BillingPolicy {
  kind: BillingResetKind
  /** Rolling window length in hours; required (1-336) when kind is 'hours'. */
  hours?: number
  /** Local reset hour (0-23) for calendar kinds; default 0 (midnight). */
  hour?: number
}

// Persisted quota bookkeeping for one backing provider: the operator-declared
// billing policy plus the last automatic quota block.
export interface ProviderQuotaState {
  billing?: BillingPolicy
  blockedUntil?: number
  reason?: string
  /**
   * The provider's own ceiling on simultaneous requests, across every model it
   * serves. Marked on the provider rather than on a backend because it is a
   * property of the account, not of one model. Counts are per pi process.
   */
  maxConcurrent?: number
}

export const SCHEDULER_SETTING_KEYS = [
  'rateLimitCooldownMs',
  'quotaCooldownMs',
  'authCooldownMs',
  'transientBaseCooldownMs',
  'maxCooldownMs',
  'errorsBeforeSwitch',
] as const satisfies readonly (keyof SchedulerSettings)[]

export interface SchedulerOptions {
  defaultPolicy?: SelectionPolicy
  affinity?: boolean
  rateLimitCooldownMs?: number
  quotaCooldownMs?: number
  authCooldownMs?: number
  transientBaseCooldownMs?: number
  maxCooldownMs?: number
  errorsBeforeSwitch?: number
  now?: () => number
  randomId?: () => string
  randomInt?: (maxExclusive: number) => number
}

export interface AccountRequestContext<TApi extends Api = Api> {
  provider: Provider<TApi>
  model: Model<TApi>
  context: TranscriptContext
  requestOptions: Readonly<StreamOptions & Record<string, unknown>>
  signal: AbortSignal
}

export interface AccountAttemptContext<TApi extends Api = Api, TCredentialRef = unknown>
  extends AccountRequestContext<TApi> {
  account: ProviderAccount<TCredentialRef>
  resolution: AuthResult
}

export interface LiftProviderOptions<TApi extends Api = Api, TCredentialRef = unknown> {
  auth?: ProviderAuth
  resolveAuth: (
    account: ProviderAccount<TCredentialRef>,
    signal: AbortSignal,
    request: AccountRequestContext<TApi>,
  ) => AuthResult | Promise<AuthResult>
  excludeAccountIds?: (
    request: AccountRequestContext<TApi>,
  ) => Iterable<string> | Promise<Iterable<string>>
  sanitizeRequestOptions?: (
    attempt: AccountAttemptContext<TApi, TCredentialRef>,
  ) => StreamOptions & Record<string, unknown>
  affinityKey?: (input: {
    provider: Provider<TApi>
    model: Model<TApi>
    context: TranscriptContext
  }) => string | undefined
  // Host session identity used only when no provider-owned affinityKey exists.
  // Kept separate so a caller-declared session (pi core sets `sessionId` on
  // stream options) can scope stickiness per nested agent without overriding an
  // integration's deliberate routing key.
  hostAffinityKey?: () => string | undefined
  disableProviderRetries?: boolean
  maxAccountAttempts?: number
  onFailover?: (info: FailoverInfo) => boolean | void
}

export interface MultiProviderIntegration<TApi extends Api = Api, TCredentialRef = unknown>
  extends ProviderRegistration<TCredentialRef>, LiftProviderOptions<TApi, TCredentialRef> {}

export const MULTIPROVIDER_REGISTER_EVENT = 'pi-multiprovider:register'

// Cross-extension service announcement. The bundled extension emits this event
// with a MultiProviderServiceAnnouncement so sibling extensions can follow the
// session's active pooled account (for example, to refresh account-scoped
// subscription usage views after /switch-account).
export const MULTIPROVIDER_SERVICE_EVENT = 'pi-multiprovider:service'

// Context slice consumers pass to the announcement; the affinity key and base
// provider lookups need only these fields.
export type MultiProviderServiceContext = Pick<
  ExtensionContext,
  'modelRegistry' | 'model' | 'sessionManager'
>

export interface ActiveAccount {
  id: string
  label: string
  authKind: AuthKind
}

export interface ActiveAccountAuth {
  accessToken: string
  label: string
  source?: string
}

export interface ActiveAccountChangedEvent {
  providerId: string
  account: ActiveAccount | undefined
  ctx: ExtensionContext
}

export interface MultiProviderServiceAnnouncement {
  getActiveAccount(
    providerId: string,
    ctx: MultiProviderServiceContext,
  ): Promise<ActiveAccount | undefined>
  resolveActiveAccountAuth(
    providerId: string,
    ctx: MultiProviderServiceContext,
    signal?: AbortSignal,
  ): Promise<ActiveAccountAuth | undefined>
  onActiveAccountChanged(
    providerId: string,
    callback: (event: ActiveAccountChangedEvent) => void,
  ): () => void
}
