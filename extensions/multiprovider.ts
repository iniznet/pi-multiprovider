import type { Api, AuthType, Credential, Model, Provider } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai'
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent'
import {
  Container,
  Input,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import {
  applySessionPins,
  BACKEND_INCOMPATIBLE_PREFIX,
  BACKEND_QUOTA_BLOCKED_PREFIX,
  BILLING_RESET_KINDS,
  bearerTokenFromAuth,
  computeResetAt,
  createHttpUsageProbe,
  createManagedIntegration,
  describeBillingPolicy,
  createServiceAnnouncement,
  detectUsageUrl,
  getMultiAuthPath,
  USAGE_WINDOW_FALLBACK_MS,
  UsageProbeCache,
  type UsageProbe,
  type FailoverInfo,
  liftProvider,
  MULTIPROVIDER_REGISTER_EVENT,
  MULTIPROVIDER_SERVICE_EVENT,
  MultiAuthStore,
  MultiProviderService,
  PI_UPSTREAM_ACCOUNT_ID,
  SCHEDULER_DEFAULTS,
  VIRTUAL_ID_SEPARATOR,
  SESSION_ATTACHMENT_REFRESH_MS,
  type AccountUsageSnapshot,
  type BillingPolicy,
  type ProviderAttemptFailure,
  type ModelThinkingLevel,
  type PublicPoolSnapshot,
  type AffinityEntry,
  type SessionAttachmentEntry,
  type VirtualServedInfo,
  mergeAttachments,
  virtualBackendAccountId,
  pickSuggestions,
  sessionsOn,
  type MultiAuthUpstreamPreferences,
  type MultiProviderIntegration,
  type MultiProviderServiceContext,
  type ProviderRegistration,
  type PublicAccountSnapshot,
  type SchedulerSettingsPatch,
  SELECTION_POLICIES,
  type SelectionPolicy,
  type SessionPin,
  type VirtualModelTemplate,
  type VirtualProviderConfig,
  captureVirtualModelTemplate,
  createVirtualIntegrations,
  createVirtualProvider,
  healVirtualTemplates,
  sessionPinsFromEntries,
  SESSION_PIN_ENTRY_TYPE,
  inheritedSessionPinsFromEnv,
  type InheritedSessionPin,
  virtualSchedulerId,
} from '../src/index.ts'
import { promptApiKeyCredential, probeSessionRuntime, selectLogin, showLoginDialog } from '../src/multilogin.ts'
import {
  openPoolManager,
  type PoolManagerAuthMethod,
  type PoolManagerCallbacks,
} from './pool-manager.ts'

type AnyIntegration = MultiProviderIntegration<Api, unknown>
type VirtualBackendRef = import('../src/index.ts').VirtualBackend

interface SettingsListInternals {
  readonly searchEnabled: boolean
  readonly searchInput: { render(width: number): string[] } | undefined
  readonly theme: SettingsListTheme
  readonly selectedIndex: number
  getDisplayItems(): SettingItem[]
  getVisibleRange(displayItems: SettingItem[]): { startIndex: number; endIndex: number }
  addHintLine(lines: string[], width: number): void
}

// SettingsList caps the label column at 36 characters, so rows misalign once
// a label runs longer; this variant sizes the value column to the longest
// label actually displayed instead.
class DynamicColumnSettingsList extends SettingsList {
  override render(width: number): string[] {
    const internal = this as unknown as SettingsListInternals
    const lines: string[] = []
    if (internal.searchEnabled && internal.searchInput) {
      lines.push(...internal.searchInput.render(width))
      lines.push('')
    }
    const displayItems = internal.getDisplayItems()
    if (displayItems.length === 0) {
      lines.push(truncateToWidth(internal.theme.hint('  No matching models'), width))
      internal.addHintLine(lines, width)
      return lines
    }
    const maxLabelWidth = Math.max(...displayItems.map(item => visibleWidth(item.label)))
    const { startIndex, endIndex } = internal.getVisibleRange(displayItems)
    for (let index = startIndex; index < endIndex; index++) {
      const item = displayItems[index]!
      const selected = index === internal.selectedIndex
      const prefix = selected ? internal.theme.cursor : '  '
      const labelPadded = item.label + ' '.repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)))
      const separator = '  '
      const valueMaxWidth = Math.max(0, width - visibleWidth(prefix) - maxLabelWidth - separator.length - 2)
      const valueText = internal.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ''), selected)
      lines.push(truncateToWidth(prefix + internal.theme.label(labelPadded, selected) + separator + valueText, width))
    }
    if (startIndex > 0 || endIndex < displayItems.length) {
      lines.push(internal.theme.hint(truncateToWidth(`  (${internal.selectedIndex + 1}/${displayItems.length})`, width - 2, '')))
    }
    internal.addHintLine(lines, width)
    return lines
  }
}

type VirtualEditorOutcome =
  | { kind: 'dismissed' }
  | { kind: 'saved'; draft: VirtualProviderConfig; billing?: Record<string, BillingPolicy | undefined>
      limits?: Record<string, number | undefined> }
  | { kind: 'discarded' }
  | { kind: 'removed'; id: string }

type EditorPage =
  | { kind: 'root' }
  | { kind: 'menu' }
  | { kind: 'provider-picker' }
  | { kind: 'model-picker' }
  | { kind: 'backend' }
  | { kind: 'provider-order' }
  | { kind: 'provider-rank' }
  | { kind: 'input'; purpose: 'provider-id' | 'model-id' | 'weight' | 'priority' | 'max-concurrent'
      | 'provider-limit' | 'provider-rank' | 'reset-hour' }

// Single-host editor for the /vprovider flow, styled after the /model and
// hide-providers selectors: every page (root menu, create inputs, editor
// menu, pickers, backend actions) swaps inside one bordered dialog the way
// /fabric settings does, so moving between pages never tears down to the
// chat view.
class VirtualProviderEditorDialog extends Container {
  private readonly theme: Theme
  private readonly stored: VirtualProviderConfig[]
  private readonly candidates: Provider<Api>[]
  private readonly isProviderIdAvailable: (id: string) => boolean
  private readonly done: (outcome: VirtualEditorOutcome) => void
  // Staged billing-marking edits (undefined value = marking off), persisted
  // with the save outcome so Save-and-apply stays the single commit point.
  private readonly billingDraft = new Map<string, BillingPolicy | undefined>()
  // Staged provider concurrency limits, persisted with the save outcome the way
  // billing markings are, so Save and apply stays the single commit point.
  private readonly limitDraft = new Map<string, number | undefined>()
  private readonly providerBilling: (providerId: string) => BillingPolicy | undefined
  private readonly providerLimit: (providerId: string) => number | undefined
  private readonly providerLoad: (poolId: string, providerId: string) => string | undefined
  private readonly providerBlockUntil: (providerId: string) => number | undefined
  private readonly accountUsage: (providerId: string) => string | undefined
  private readonly flaggedLevels: (providerId: string, modelId: string) => string[]
  private readonly poolAttachments: (poolId: string) => AffinityEntry[]
  private readonly backendLoad: (poolId: string, accountId: string) => string | undefined
  private readonly currentSessionKey: () => string
  private readonly clearProviderBlock: (providerId: string) => void
  private readonly pageContainer = new Container()
  private readonly listTheme: SettingsListTheme
  private draft: VirtualProviderConfig | undefined
  private page: EditorPage
  private inputBackPage: EditorPage = { kind: 'root' }
  private createProviderId: string | undefined
  private chosenProvider: Provider<Api> | undefined
  private activeBackendIndex = 0
  // Provider whose billing reset hour the input page is currently editing.
  private activeResetHourProvider: string | undefined
  private activeLimitProvider: string | undefined
  private activeRankProvider: string | undefined
  private inputInitial = ''
  private pageError = ''
  private activeList: SettingsList | undefined
  private activeInput: Input | undefined

  constructor(options: {
    theme: Theme
    stored: VirtualProviderConfig[]
    candidates: Provider<Api>[]
    isProviderIdAvailable: (id: string) => boolean
    startDraft: VirtualProviderConfig | undefined
    providerBilling?: (providerId: string) => BillingPolicy | undefined
    providerLimit?: (providerId: string) => number | undefined
    providerLoad?: (poolId: string, providerId: string) => string | undefined
    providerBlockUntil?: (providerId: string) => number | undefined
    accountUsage?: (providerId: string) => string | undefined
    flaggedLevels?: (providerId: string, modelId: string) => string[]
    poolAttachments?: (poolId: string) => AffinityEntry[]
    backendLoad?: (poolId: string, accountId: string) => string | undefined
    currentSessionKey?: () => string
    clearProviderBlock?: (providerId: string) => void
    done: (outcome: VirtualEditorOutcome) => void
  }) {
    super()
    this.theme = options.theme
    this.stored = options.stored
    this.candidates = options.candidates
    this.isProviderIdAvailable = options.isProviderIdAvailable
    this.providerBilling = options.providerBilling ?? (() => undefined)
    this.providerBlockUntil = options.providerBlockUntil ?? (() => undefined)
    this.accountUsage = options.accountUsage ?? (() => undefined)
    this.providerLimit = options.providerLimit ?? (() => undefined)
    this.providerLoad = options.providerLoad ?? (() => undefined)
    this.flaggedLevels = options.flaggedLevels ?? (() => [])
    this.poolAttachments = options.poolAttachments ?? (() => [])
    this.backendLoad = options.backendLoad ?? (() => undefined)
    this.currentSessionKey = options.currentSessionKey ?? (() => '')
    this.clearProviderBlock = options.clearProviderBlock ?? (() => undefined)
    this.done = options.done
    this.draft = options.startDraft
    this.page = options.startDraft === undefined ? { kind: 'root' } : { kind: 'menu' }
    this.listTheme = {
      label: (text, selected) => (selected ? this.theme.fg('accent', text) : text),
      value: text => this.theme.fg('muted', text),
      description: text => this.theme.fg('muted', text),
      cursor: this.theme.fg('accent', '→ '),
      hint: text => this.theme.fg('muted', text),
    }
    this.addChild(new DynamicBorder(s => this.theme.fg('border', s)))
    this.addChild(new Spacer(1))
    this.addChild(this.pageContainer)
    this.addChild(new DynamicBorder(s => this.theme.fg('border', s)))
    this.enterPage()
  }

  handleInput(data: string): void {
    if (this.activeInput !== undefined) this.activeInput.handleInput(data)
    else this.activeList?.handleInput(data)
  }

  private goTo(page: EditorPage): void {
    this.page = page
    this.pageError = ''
    this.enterPage()
  }

  private enterPage(): void {
    this.activeList = undefined
    this.activeInput = undefined
    this.pageContainer.clear()
    if (this.page.kind === 'root') this.buildRoot()
    else if (this.page.kind === 'menu') this.buildMenu()
    else if (this.page.kind === 'provider-picker') this.buildProviderPicker()
    else if (this.page.kind === 'model-picker') this.buildModelPicker()
    else if (this.page.kind === 'backend') this.buildBackendActions()
    else if (this.page.kind === 'provider-order') this.buildProviderOrder()
    else if (this.page.kind === 'provider-rank') this.buildProviderRankActions()
    else this.buildInput()
  }

  // Matches the /model and hide-providers selectors: blank line after the
  // border, flush-left accent title, muted description, then the list.
  private addHeading(title: string, description: string): void {
    this.pageContainer.addChild(new Text(this.theme.fg('accent', this.theme.bold(title)), 0, 0))
    this.pageContainer.addChild(new Text(this.theme.fg('muted', description), 0, 0))
    this.pageContainer.addChild(new Spacer(1))
    if (this.pageError !== '') {
      this.pageContainer.addChild(new Text(this.theme.fg('warning', this.pageError), 0, 0))
      this.pageContainer.addChild(new Spacer(1))
    }
  }

  private attachList(
    title: string,
    description: string,
    items: SettingItem[],
    onSelect: (id: string) => void,
    onCancel: () => void,
  ): void {
    this.addHeading(title, description)
    this.activeList = new DynamicColumnSettingsList(
      items,
      10,
      this.listTheme,
      id => onSelect(id),
      onCancel,
      { enableSearch: true },
    )
    this.pageContainer.addChild(this.activeList)
  }

  private menuItem(id: string, label: string): SettingItem {
    return { id, label, currentValue: '', values: [id] }
  }

  private separatorItem(id: string): SettingItem {
    return { id, label: '', currentValue: '' }
  }

  private buildRoot(): void {
    const items: SettingItem[] = [
      this.menuItem('create', 'Create new virtual provider'),
      ...this.stored.map(config => this.menuItem(`edit-${config.id}`, `Edit ${config.id}`)),
      ...this.stored.map(config => this.menuItem(`delete-${config.id}`, `Delete ${config.id}`)),
    ]
    this.attachList(
      'Virtual providers',
      'Create, edit, or remove virtual providers that map one model across provider models.',
      items,
      id => {
        if (id === 'create') {
          this.createProviderId = undefined
          this.inputBackPage = { kind: 'root' }
          this.inputInitial = 'pooled'
          this.goTo({ kind: 'input', purpose: 'provider-id' })
        } else if (id.startsWith('edit-')) {
          const target = this.stored.find(candidate => candidate.id === id.slice(5))
          if (target === undefined) return
          this.draft = structuredClone(target)
          this.goTo({ kind: 'menu' })
        } else if (id.startsWith('delete-')) {
          this.done({ kind: 'removed', id: id.slice(7) })
        }
      },
      () => this.done({ kind: 'dismissed' }),
    )
  }

  // Billing-cycle sequence behind the per-provider row: off -> daily ->
  // weekly -> monthly -> 5h window -> off.
  private static readonly BILLING_CYCLE: (BillingPolicy | undefined)[] = [
    undefined,
    { kind: 'daily' },
    { kind: 'weekly' },
    { kind: 'monthly' },
    { kind: 'hours', hours: 5 },
  ]

  private billingLabel(providerId: string): string {
    const staged = this.activeBillingPolicy(providerId)
    return staged === undefined ? 'off' : describeBillingPolicy(staged)
  }

  private activeBillingPolicy(providerId: string): BillingPolicy | undefined {
    return this.billingDraft.has(providerId)
      ? this.billingDraft.get(providerId)
      : this.providerBilling(providerId)
  }

  // A provider ceiling belongs to the provider, not to one model, so it is
  // staged and persisted like the billing marking rather than inside the config.
  private activeLimit(providerId: string): number | undefined {
    return this.limitDraft.has(providerId)
      ? this.limitDraft.get(providerId)
      : this.providerLimit(providerId)
  }

  private limitLabel(providerId: string): string {
    const limit = this.activeLimit(providerId)
    return limit === undefined ? 'uncapped' : `${limit} concurrent per process`
  }

  private buildMenu(): void {
    const model = this.draft!.models[0]!
    const poolId = virtualSchedulerId(this.draft!.id, model.id)
    const strategy = this.draft!.strategy ?? 'round-robin'
    const providerStrategy = this.draft!.providerStrategy
    const affinity = this.draft!.affinity !== false
    const billingProviders = [...new Set(
      model.backends.filter(backend => backend.enabled !== false).map(backend => backend.providerId),
    )]
    const blockedProviders = billingProviders.filter(
      providerId => (this.providerBlockUntil(providerId) ?? 0) > Date.now(),
    )
    const items: SettingItem[] = [
      this.menuItem('model-id', `Model id: ${model.id}`),
      // Two levels when the operator wants them: the provider strategy spreads
      // load across backing providers, then the model strategy picks inside the
      // chosen one. Off keeps the pool on one flat pass over every backend.
      this.menuItem('provider-strategy', `Provider strategy: ${providerStrategy ?? 'off (one flat pass)'}`),
      this.menuItem('strategy', `Model strategy: ${strategy}`
        + (providerStrategy === undefined ? ' · all backends' : ' · within provider')),
      this.menuItem('affinity', `Session affinity: ${affinity ? 'on (sticky per session)' : 'off (rotate)'}`),
      this.menuItem('provider-order', 'Providers (priority order)'),
      this.menuItem('add', 'Add backing provider model'),
      ...billingProviders.map(providerId => this.menuItem(
        'billing-' + providerId,
        `Billing (${providerId}): ${this.billingLabel(providerId)}`,
      )),
      // Calendar billing kinds get a configurable local reset hour; the
      // rolling 'hours' window has none (it always resets a full window later).
      ...billingProviders
        .filter(providerId => {
          const policy = this.activeBillingPolicy(providerId)
          return policy !== undefined && policy.kind !== 'hours'
        })
        .map(providerId => this.menuItem(
          'reset-hour-' + providerId,
          `Reset hour (${providerId}): ${String(this.activeBillingPolicy(providerId)!.hour ?? 0).padStart(2, '0')}:00`,
        )),
      // The ceiling is shown with live load so an operator can see a provider
      // filling up before sending the next request.
      ...billingProviders.map(providerId => this.menuItem(
        'limit-' + providerId,
        `Limit (${providerId}): ${this.limitLabel(providerId)}`
          + (this.providerLoad(poolId, providerId) === undefined
            ? ''
            : ` · ${this.providerLoad(poolId, providerId)}`),
      )),
      ...blockedProviders.map(providerId => this.menuItem(
        'clear-quota-' + providerId,
        `Clear quota block (${providerId} · until ${new Date(this.providerBlockUntil(providerId)!).toLocaleTimeString()})`,
      )),
      this.separatorItem('sep-top'),
      ...model.backends.map((backend, index) => {
        const blocked = (this.providerBlockUntil(backend.providerId) ?? 0) > Date.now()
        const flags = this.flaggedLevels(backend.providerId, backend.modelId)
        const flagged = flags.length > 0
        const usage = this.accountUsage(backend.providerId)
        const accountId = virtualBackendAccountId(backend)
        // Which sessions are on this backend, across every open pi process.
        const attached = sessionsOn(this.poolAttachments(poolId), accountId, this.currentSessionKey())
        // Live leases against this backend's concurrency cap, when known.
        const load = this.backendLoad(poolId, accountId)
        return this.menuItem(
          `backend-${index}`,
          `${index + 1}. ${backend.providerId}`
            + this.theme.fg('dim', ` · ${backend.modelId} · ${backend.enabled === false ? 'disabled' : 'enabled'} · w${backend.weight ?? 1}`
              + (backend.priority === undefined ? '' : ` · p${backend.priority}`)
              + (blocked ? ' · quota-blocked' : '')
              + (flagged ? ' · flagged(' + flags.join(',') + ')' : '')
              + (attached === undefined ? ' · no sessions' : ` · ${attached}`)
              + (load === undefined ? '' : ` · ${load}`)
              + (usage === undefined ? '' : ` · ${usage}`)),
        )
      }),
      this.separatorItem('sep-bottom'),
      this.menuItem('save', 'Save and apply'),
      this.menuItem('discard', 'Discard changes'),
    ]
    this.attachList(
      `Virtual provider "${this.draft!.id}"`,
      'Enter selects · Esc discards changes.',
      items,
      id => {
        if (id === 'model-id') {
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = model.id
          this.goTo({ kind: 'input', purpose: 'model-id' })
        } else if (id === 'provider-order') {
          this.goTo({ kind: 'provider-order' })
        } else if (id === 'provider-strategy') {
          const next = nextProviderStrategy(this.draft!.providerStrategy)
          if (next === 'off') delete this.draft!.providerStrategy
          else this.draft!.providerStrategy = next
          this.goTo({ kind: 'menu' })
        } else if (id === 'strategy') {
          // Cycle the persisted pool strategy; round-robin keeps the virtual
          // pool's unbiased rotation, the others map onto pool scheduling.
          const current = this.draft!.strategy ?? 'round-robin'
          const next = SELECTION_POLICIES[(SELECTION_POLICIES.indexOf(current) + 1) % SELECTION_POLICIES.length]!
          this.draft!.strategy = next
          this.goTo({ kind: 'menu' })
        } else if (id === 'affinity') {
          // Off rotates backends by policy instead of reusing a session's first
          // pick: for fan-out hosts whose nested agents share one session
          // identity and would otherwise concentrate on one credential.
          // Explicit /switch-account pins still take precedence.
          this.draft!.affinity = this.draft!.affinity === false
          this.goTo({ kind: 'menu' })
        } else if (id.startsWith('billing-')) {
          const providerId = id.slice('billing-'.length)
          const cycle = VirtualProviderEditorDialog.BILLING_CYCLE
          const current = this.billingDraft.has(providerId)
            ? this.billingDraft.get(providerId)
            : this.providerBilling(providerId)
          const index = cycle.findIndex(
            entry => entry === undefined ? current === undefined : entry.kind === current?.kind,
          )
          this.billingDraft.set(providerId, cycle[(index + 1) % cycle.length]!)
          this.goTo({ kind: 'menu' })
        } else if (id.startsWith('reset-hour-')) {
          const providerId = id.slice('reset-hour-'.length)
          this.activeResetHourProvider = providerId
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = String(this.activeBillingPolicy(providerId)?.hour ?? 0)
          this.goTo({ kind: 'input', purpose: 'reset-hour' })
        } else if (id.startsWith('limit-')) {
          const providerId = id.slice('limit-'.length)
          const limit = this.activeLimit(providerId)
          this.activeLimitProvider = providerId
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = limit === undefined ? '' : String(limit)
          this.goTo({ kind: 'input', purpose: 'provider-limit' })
        } else if (id.startsWith('clear-quota-')) {
          this.clearProviderBlock(id.slice('clear-quota-'.length))
          this.goTo({ kind: 'menu' })
        } else if (id === 'add') {
          this.goTo({ kind: 'provider-picker' })
        } else if (id === 'save') {
          if (model.backends.filter(backend => backend.enabled !== false).length === 0) {
            this.pageError = 'Add at least one enabled backing provider model before saving.'
            this.enterPage()
            return
          }
          // Heal templates for backends stored before capture existed; live
          // resolution still wins at runtime — this covers the snapshot taken
          // before backing providers register.
          for (const backend of model.backends) {
            if (backend.enabled === false || backend.template !== undefined) continue
            const candidate = this.candidates
              .find(provider => provider.id === backend.providerId)
              ?.getModels()
              .find(item => item.id === backend.modelId)
            if (candidate !== undefined) backend.template = captureVirtualModelTemplate(candidate)
          }
          const stagedBilling = this.billingDraft.size === 0
            ? undefined
            : Object.fromEntries(this.billingDraft)
          const stagedLimits = this.limitDraft.size === 0
            ? undefined
            : Object.fromEntries(this.limitDraft)
          this.done({
            kind: 'saved',
            draft: this.draft!,
            ...(stagedBilling === undefined ? {} : { billing: stagedBilling }),
            ...(stagedLimits === undefined ? {} : { limits: stagedLimits }),
          })
        } else if (id === 'discard') {
          this.done({ kind: 'discarded' })
        } else if (id.startsWith('backend-')) {
          this.activeBackendIndex = Number(id.slice(8))
          this.goTo({ kind: 'backend' })
        }
      },
      () => this.done({ kind: 'discarded' }),
    )
  }

  private buildProviderPicker(): void {
    const items: SettingItem[] = this.candidates.map(provider => ({
      id: provider.id,
      label: `${provider.name} (${provider.id})`,
      currentValue: '',
      values: [provider.id],
    }))
    this.attachList(
      'Backing provider',
      'Type to search · Enter picks the provider · Esc goes back.',
      items,
      id => {
        const chosen = this.candidates.find(candidate => candidate.id === id)
        if (chosen === undefined) return
        this.chosenProvider = chosen
        this.goTo({ kind: 'model-picker' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildModelPicker(): void {
    const catalog = this.chosenProvider!.getModels()
    const items: SettingItem[] = catalog.map(candidate => ({
      id: candidate.id,
      label: candidate.id,
      currentValue: candidate.name,
      values: [candidate.id],
    }))
    this.attachList(
      `Backing model for ${this.chosenProvider!.name}`,
      'Type to search · Enter picks the model · Esc goes back.',
      items,
      id => {
        const chosen = catalog.find(candidate => candidate.id === id)
        const providerId = this.chosenProvider?.id
        if (chosen === undefined || providerId === undefined) return
        const model = this.draft!.models[0]!
        if (model.backends.some(backend =>
          backend.providerId === providerId && backend.modelId === chosen.id)) {
          this.pageError = 'That provider model is already a backend.'
          this.enterPage()
          return
        }
        model.backends.push({
          providerId,
          modelId: chosen.id,
          weight: 1,
          // Persisted so the virtual model advertises correct thinking support
          // before backing providers register (pi snapshots models at load).
          template: captureVirtualModelTemplate(chosen),
        })
        this.goTo({ kind: 'menu' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  // Distinct providers of the model being edited, in the order a priority
  // strategy will try them. An explicit rank wins over the best backend rank so
  // ordering never depends on which backend happens to carry a number.
  private orderedProviders(): string[] {
    const model = this.draft!.models[0]!
    const appearance = new Map<string, number>()
    for (const backend of model.backends) {
      if (!appearance.has(backend.providerId)) appearance.set(backend.providerId, appearance.size)
    }
    const rank = (providerId: string): number => this.draft!.providerPriority?.[providerId]
      ?? Math.min(...model.backends.filter(backend => backend.providerId === providerId)
        .map(backend => backend.priority ?? 0))
    return [...appearance.keys()]
      .sort((left, right) => rank(left) - rank(right) || appearance.get(left)! - appearance.get(right)!)
  }

  // Moving materializes the whole list as sequential ranks: before the first
  // move a pool can hold deliberate ties that load-share, and rewriting every
  // entry is how an ambiguous derived order becomes an explicit one.
  private moveProvider(providerId: string, delta: -1 | 0 | 1): void {
    const order = this.orderedProviders()
    const from = order.indexOf(providerId)
    if (from < 0 || order.length < 2) return
    const to = delta === 0 ? 0 : Math.min(order.length - 1, Math.max(0, from + delta))
    if (to === from) return
    order.splice(from, 1)
    order.splice(to, 0, providerId)
    // Ranks for providers outside the model being edited are preserved: one
    // virtual provider can hold several models over different providers.
    const priorities: Record<string, number> = { ...(this.draft!.providerPriority ?? {}) }
    order.forEach((id, position) => { priorities[id] = position })
    this.draft!.providerPriority = priorities
  }

  // Same materialize-then-assign rule for models. Ranking the whole list keeps
  // each provider's internal order intact, because selection compares models
  // only inside the provider it already chose.
  private moveBackend(delta: -1 | 0 | 1): void {
    const backends = this.draft!.models[0]!.backends
    if (backends.length < 2) return
    const ranked = backends
      .map((backend, position) => ({ backend, position }))
      .sort((left, right) => (left.backend.priority ?? 0) - (right.backend.priority ?? 0)
        || left.position - right.position)
      .map(entry => entry.backend)
    const from = ranked.indexOf(backends[this.activeBackendIndex]!)
    if (from < 0) return
    const to = delta === 0 ? 0 : Math.min(ranked.length - 1, Math.max(0, from + delta))
    if (to === from) return
    ranked.splice(from, 1)
    ranked.splice(to, 0, backends[this.activeBackendIndex]!)
    ranked.forEach((backend, position) => { backend.priority = position })
    this.activeBackendIndex = to
  }

  private orderedBackendPosition(): number {
    const backends = this.draft!.models[0]!.backends
    const active = backends[this.activeBackendIndex]
    if (active === undefined) return 0
    const ranked = backends
      .map((backend, position) => ({ backend, position }))
      .sort((left, right) => (left.backend.priority ?? 0) - (right.backend.priority ?? 0)
        || left.position - right.position)
    return ranked.findIndex(entry => entry.backend === active) + 1
  }

  private buildProviderOrder(): void {
    const order = this.orderedProviders()
    const model = this.draft!.models[0]!
    const explicit = this.draft!.providerPriority !== undefined
    const items = [
      ...order.map((providerId, position) => this.menuItem(
        'provider-rank-' + providerId,
        `${position + 1}. ${providerId}`
          + ` · rank ${this.draft!.providerPriority?.[providerId] ?? position}`
          + ` · ${model.backends.filter(backend => backend.providerId === providerId).length} model(s)`,
      )),
      ...(explicit
        ? [this.menuItem('rank-derive', 'Clear explicit ranks (rank by backends again)')]
        : []),
    ]
    // The header states which ranking mode is active, because a derived rank and
    // an explicit one can show the same numbers while behaving differently.
    const source = explicit
      ? 'ranks are explicit'
      : 'ranks are derived from the best backend of each provider'
    this.attachList(
      'Providers in priority order',
      order.length < 2
        ? `This pool has one provider, so there is nothing to order · ${source}.`
        : `Enter opens a provider to move it · ${source}.`
          + (explicit ? '' : ' Moving makes the order explicit for every provider.'),
      items,
      id => {
        if (id === 'rank-derive') {
          delete this.draft!.providerPriority
          this.goTo({ kind: 'provider-order' })
          return
        }
        this.activeRankProvider = id.slice('provider-rank-'.length)
        this.goTo({ kind: 'provider-rank' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildProviderRankActions(): void {
    const providerId = this.activeRankProvider
    if (providerId === undefined) {
      this.goTo({ kind: 'menu' })
      return
    }
    const items: SettingItem[] = [
      this.menuItem('rank-up', 'Move up (toward first)'),
      this.menuItem('rank-down', 'Move down (toward last)'),
      this.menuItem('rank-front', 'Move to front'),
      this.menuItem('rank-set',
        `Set rank (now ${this.draft!.providerPriority?.[providerId] ?? 'derived from backends'})`),
    ]
    this.attachList(
      `Order ${providerId} · ${this.orderedProviders().indexOf(providerId) + 1} of ${this.orderedProviders().length}`,
      'Enter applies · Esc goes back to the order list.',
      items,
      id => {
        if (id === 'rank-up') {
          this.moveProvider(providerId, -1)
        } else if (id === 'rank-down') {
          this.moveProvider(providerId, 1)
        } else if (id === 'rank-front') {
          this.moveProvider(providerId, 0)
        } else if (id === 'rank-set') {
          const current = this.draft!.providerPriority?.[providerId]
          this.inputBackPage = { kind: 'provider-rank' }
          this.inputInitial = current === undefined ? '' : String(current)
          this.goTo({ kind: 'input', purpose: 'provider-rank' })
          return
        }
        this.goTo({ kind: 'provider-order' })
      },
      () => this.goTo({ kind: 'provider-order' }),
    )
  }

  private buildBackendActions(): void {
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]!
    const items: SettingItem[] = [
      this.menuItem('toggle', backend.enabled === false ? 'Enable' : 'Disable'),
      this.menuItem('move-up', 'Move up (toward first)'),
      this.menuItem('move-down', 'Move down (toward last)'),
      this.menuItem('move-front', 'Move to front'),
      this.menuItem('weight', 'Set weight'),
      this.menuItem('max-concurrent',
        `Set max concurrent requests (now ${backend.maxConcurrent === undefined ? 'uncapped' : backend.maxConcurrent})`),
      this.menuItem('priority', `Set priority (lower runs first · now ${backend.priority ?? 0})`),
      this.menuItem('position', `Order position: ${this.orderedBackendPosition()} of ${this.draft!.models[0]!.backends.length}`),
      this.menuItem('remove', 'Remove'),
    ]
    this.attachList(
      `${backend.providerId} · ${backend.modelId}`,
      'Enter selects · Esc goes back.',
      items,
      id => {
        if (id === 'toggle') {
          backend.enabled = backend.enabled === false
        } else if (id === 'weight') {
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = String(backend.weight ?? 1)
          this.goTo({ kind: 'input', purpose: 'weight' })
        } else if (id === 'move-up') {
          this.moveBackend(-1)
        } else if (id === 'move-down') {
          this.moveBackend(1)
        } else if (id === 'move-front') {
          this.moveBackend(0)
        } else if (id === 'max-concurrent') {
          this.inputBackPage = { kind: 'backend' }
          this.inputInitial = backend.maxConcurrent === undefined ? '' : String(backend.maxConcurrent)
          this.goTo({ kind: 'input', purpose: 'max-concurrent' })
        } else if (id === 'priority') {
          this.inputBackPage = { kind: 'backend' }
          this.inputInitial = String(backend.priority ?? 0)
          this.goTo({ kind: 'input', purpose: 'priority' })
        } else if (id === 'remove') {
          this.draft!.models[0]!.backends.splice(this.activeBackendIndex, 1)
        } else return
        this.goTo({ kind: 'menu' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildInput(): void {
    const purpose = this.page.kind === 'input' ? this.page.purpose : 'model-id'
    const title = purpose === 'provider-id'
      ? 'Virtual provider id'
      : purpose === 'model-id'
      ? 'Virtual model id (shown in /model)'
      : purpose === 'reset-hour'
      ? 'Set reset hour (0-23, local time)'
      : purpose === 'provider-rank'
      ? `Provider rank for ${this.activeRankProvider ?? ''} (0 runs first)`
      : purpose === 'provider-limit'
      ? `Provider concurrency limit (${this.activeLimitProvider ?? ''}, per process; 0 clears)`
      : purpose === 'max-concurrent'
      ? 'Set max concurrent requests (0 clears the cap)'
      : purpose === 'priority' ? 'Set priority (lower runs first)' : 'Set weight'
    this.addHeading(title, 'Enter confirms · Esc goes back.')
    const input = new Input()
    input.setValue(this.inputInitial)
    input.onSubmit = () => purpose === 'priority'
      ? this.applyPriorityInput(input.getValue())
      : purpose === 'max-concurrent'
      ? this.applyConcurrencyInput(input.getValue())
      : purpose === 'provider-limit'
      ? this.applyProviderLimitInput(input.getValue())
      : purpose === 'provider-rank'
      ? this.applyProviderRankInput(input.getValue())
      : purpose === 'reset-hour'
      ? this.applyResetHourInput(input.getValue())
      : this.applyInput(purpose, input.getValue())
    input.onEscape = () => this.goTo(this.inputBackPage)
    this.activeInput = input
    this.pageContainer.addChild(input)
    // Pages without a SettingsList footer (the list pages get one from
    // addHintLine) need a trailing blank row so the input does not sit
    // flush against the bottom border.
    this.pageContainer.addChild(new Spacer(1))
  }

  private applyInput(purpose: 'provider-id' | 'model-id' | 'weight' | 'priority', raw: string): void {
    const value = raw.trim()
    if (purpose === 'provider-id') {
      if (!VIRTUAL_ID_PATTERN.test(value) || !this.isProviderIdAvailable(value)) {
        this.pageError = 'Provider id is invalid or already registered.'
        this.inputInitial = value
        this.enterPage()
        return
      }
      this.createProviderId = value
      this.inputInitial = value
      this.goTo({ kind: 'input', purpose: 'model-id' })
      return
    }
    if (purpose === 'model-id') {
      if (!VIRTUAL_ID_PATTERN.test(value)) {
        this.pageError = 'Use letters, numbers, dots, dashes, or underscores for the model id.'
        this.inputInitial = value
        this.enterPage()
        return
      }
      if (this.draft === undefined) {
        this.draft = {
          id: this.createProviderId!,
          label: this.createProviderId!,
          strategy: 'round-robin',
          models: [{ id: value, backends: [] }],
        }
        this.pageError = 'Add at least one enabled backing provider model, then choose "Save and apply".'
      } else {
        this.draft.models[0]!.id = value
      }
      this.goTo({ kind: 'menu' })
      return
    }
    const parsed = Number(value)
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]
    if (!Number.isInteger(parsed) || parsed < 1 || backend === undefined) {
      this.pageError = 'Weight must be an integer ≥ 1.'
      this.inputInitial = value
      this.enterPage()
      return
    }
    backend.weight = parsed
    this.goTo({ kind: 'menu' })
  }

  private applyResetHourInput(raw: string): void {
    const providerId = this.activeResetHourProvider
    const parsed = Number(raw.trim())
    if (providerId === undefined || !Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
      this.pageError = 'Reset hour must be an integer 0-23 (local time).'
      this.inputInitial = raw
      this.enterPage()
      return
    }
    const policy = this.activeBillingPolicy(providerId)
    if (policy === undefined || policy.kind === 'hours') {
      this.goTo({ kind: 'menu' })
      return
    }
    this.billingDraft.set(providerId, { ...policy, hour: parsed })
    this.goTo({ kind: 'menu' })
  }

  private applyProviderRankInput(raw: string): void {
    const providerId = this.activeRankProvider
    if (providerId === undefined) {
      this.goTo({ kind: 'menu' })
      return
    }
    const parsed = Number(raw.trim())
    if (!Number.isInteger(parsed) || parsed < 0) {
      this.pageError = 'Provider rank must be a whole number from 0 up.'
      this.inputInitial = raw
      this.enterPage()
      return
    }
    // Materialize the visible order, then override the one entry being set, so
    // a hand-picked rank never silently reorders its neighbours.
    const order = this.orderedProviders()
    const priorities: Record<string, number> = { ...(this.draft!.providerPriority ?? {}) }
    order.forEach((other, position) => { priorities[other] = position })
    priorities[providerId] = parsed
    this.draft!.providerPriority = priorities
    this.goTo({ kind: 'provider-rank' })
  }

  private applyProviderLimitInput(raw: string): void {
    const providerId = this.activeLimitProvider
    if (providerId === undefined) {
      this.goTo({ kind: 'menu' })
      return
    }
    const value = raw.trim()
    if (value === '') {
      this.limitDraft.set(providerId, undefined)
      this.goTo({ kind: 'menu' })
      return
    }
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0) {
      this.pageError = 'Provider limit must be a whole number (0 or blank clears the ceiling).'
      this.inputInitial = raw
      this.enterPage()
      return
    }
    this.limitDraft.set(providerId, parsed === 0 ? undefined : parsed)
    this.goTo({ kind: 'menu' })
  }

  private applyConcurrencyInput(raw: string): void {
    const value = raw.trim()
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]
    if (backend === undefined) {
      this.goTo({ kind: 'menu' })
      return
    }
    // Blank and 0 both mean "no cap": the limit is advisory, so clearing it
    // never leaves a working backend unreachable.
    if (value === '') {
      delete backend.maxConcurrent
      this.goTo({ kind: 'menu' })
      return
    }
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0) {
      this.pageError = 'Max concurrent requests must be an integer (0 or blank clears the cap).'
      this.inputInitial = raw
      this.enterPage()
      return
    }
    if (parsed === 0) delete backend.maxConcurrent
    else backend.maxConcurrent = parsed
    this.goTo({ kind: 'menu' })
  }

  private applyPriorityInput(raw: string): void {
    const parsed = Number(raw.trim())
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]
    if (!Number.isInteger(parsed) || parsed < 0 || backend === undefined) {
      this.pageError = 'Priority must be an integer ≥ 0 (lower runs first).'
      this.inputInitial = raw
      this.enterPage()
      return
    }
    backend.priority = parsed
    this.goTo({ kind: 'menu' })
  }
}

// Names what a pool actually runs: one strategy on a flat pool, both levels
// once an operator picks a provider strategy, so a row never advertises a
// strategy that is not the one selecting.
function strategyLabel(pool: PublicPoolSnapshot): string {
  return pool.groupPolicy === undefined ? pool.policy : `${pool.groupPolicy}+${pool.policy}`
}

// Cycles off, then every pool strategy, then back to off. `undefined` returns
// as the literal string 'off' marker absent from the config, so a flat pool
// stays byte-identical on disk.
function nextProviderStrategy(
  current: SelectionPolicy | undefined,
): SelectionPolicy | 'off' {
  const cycle: readonly (SelectionPolicy | undefined)[] = [undefined, ...SELECTION_POLICIES]
  return cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? 'off'
}

function isIntegration(value: unknown): value is AnyIntegration {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AnyIntegration>
  return typeof candidate.id === 'string'
    && candidate.id.trim() !== ''
    && typeof candidate.label === 'string'
    && typeof candidate.accounts === 'function'
    && typeof candidate.resolveAuth === 'function'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// '2h14m' / '3d20h' / '45m' — compact countdown for usage-window resets.
function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return days + 'd' + hours + 'h'
  if (hours > 0) return hours + 'h' + (mins > 0 ? String(mins) + 'm' : '')
  return mins + 'm'
}

// '5h: 63% · 7d: 41% · 30d: 12% ↺ 20d0h' — remaining budget per window with a
// reset countdown only on exhausted windows.
function formatUsageSummary(snapshot: AccountUsageSnapshot): string {
  return snapshot.windows.map(window => {
    let text = window.label + ': ' + window.remainingPercent + '%'
    if (window.rateLimited && window.resetsAt !== null) {
      text += ' ↺ ' + formatDuration(window.resetsAt - Date.now())
    }
    return text
  }).join(' · ')
}

function statusLines(
  snapshot: Awaited<ReturnType<MultiProviderService['snapshot']>>,
  accountUsage?: (providerId: string, accountId: string) => string | undefined,
): string[] {
  const lines: string[] = []
  for (const provider of snapshot.providers) {
    lines.push(
      `${provider.label} (${provider.id}) · ${provider.policy}`
      + `${provider.firstAccountBias ? ' · main-first' : ''}`
      + ` · affinity ${provider.affinity ? 'on' : 'off'}`,
    )
    if (provider.accounts.length === 0) {
      lines.push('  no accounts')
      continue
    }
    for (const account of provider.accounts) {
      const cooldown = account.cooldownUntil === undefined
        ? ''
        : ` · cooldown until ${new Date(account.cooldownUntil).toLocaleTimeString()}`
      const usage = accountUsage?.(provider.id, account.id)
      lines.push(
        `  ${account.label} (${account.authKind}) · ${account.status} · w${account.weight} · p${account.priority} · ${account.inFlight} in flight · ${account.consecutiveFailures} failures${cooldown}`
          + (usage === undefined ? '' : ` · ${usage}`),
      )
    }
  }
  return lines
}

const AUTOMATIC_SWITCH_REFS = new Set(['auto', 'automatic'])

// Runs the pool's configured strategy immediately and keeps its answer, so an
// operator can see where a session will land before spending a request on it.
const PICK_STRATEGY_REF = 'pick'

// Ids compose into scheduler ids and backend account ids via '::' separators.
const VIRTUAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

function switchAccountLabel(
  account: PublicAccountSnapshot,
  current: boolean,
  attached?: string,
): string {
  const kind = account.id === PI_UPSTREAM_ACCOUNT_ID ? 'upstream' : account.authKind
  const status = account.status === 'cooldown' && account.cooldownUntil !== undefined
    ? `cooldown until ${new Date(account.cooldownUntil).toLocaleTimeString()}`
    : account.status
  return [
    `${account.label} (${kind})`,
    status,
    `w${account.weight} · p${account.priority}`,
    ...(current ? ['current'] : []),
    // Which sessions already sit on this account: the difference between
    // "somewhere idle" and "everyone lands here".
    attached ?? 'no sessions',
  ].join(' · ')
}

function switchAccountLabels(
  accounts: readonly PublicAccountSnapshot[],
  currentId: string | undefined,
  attachedOf?: (accountId: string) => string | undefined,
): string[] {
  const labels = accounts.map(account =>
    switchAccountLabel(account, account.id === currentId, attachedOf?.(account.id)))
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return labels.map((label, index) =>
    (counts.get(label) ?? 0) > 1 ? `${label} · ${accounts[index]!.id.slice(0, 8)}` : label)
}

function uniqueProviders(
  ctx: ExtensionContext,
  baseProviders: ReadonlyMap<string, Provider<Api>>,
): Provider<Api>[] {
  const ids = new Set(ctx.modelRegistry.getAll().map(model => model.provider))
  for (const id of baseProviders.keys()) ids.add(id)
  const providers: Provider<Api>[] = []
  for (const id of ids) {
    const provider = baseProviders.get(id)
      ?? ctx.modelRegistry.getProvider(id) as Provider<Api> | undefined
    if (provider !== undefined) providers.push(provider)
  }
  return providers.sort((left, right) => left.name.localeCompare(right.name))
}

export default async function multiprovider(pi: ExtensionAPI): Promise<void> {
  const service = new MultiProviderService()
  const store = new MultiAuthStore()

  // Provider-level quota bookkeeping. Billing markings come from the store's
  // providerQuota section; active blocks survive restarts via the same section.
  const providerBilling = new Map<string, BillingPolicy>()
  const providerLimits = new Map<string, number>()
  const quotaBlocks = new Map<string, { until: number; reason?: string }>()
  const flaggedBackends = new Set<string>()
  for (const [providerId, entry] of Object.entries(await store.listProviderQuota())) {
    if (entry.billing !== undefined) providerBilling.set(providerId, entry.billing)
    if (entry.maxConcurrent !== undefined) providerLimits.set(providerId, entry.maxConcurrent)
    if (entry.blockedUntil !== undefined && entry.blockedUntil > Date.now()) {
      quotaBlocks.set(providerId, {
        until: entry.blockedUntil,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      })
    }
  }

  // Ceilings for a pool's groups, keyed by backing provider id. An empty set
  // returns null, which clears whatever the pool held before, so removing a
  // limit takes effect on the next reconcile instead of lasting until restart.
  const groupLimitsFor = (providerIds: readonly string[]): Record<string, number> | null => {
    const limits: Record<string, number> = {}
    for (const providerId of providerIds) {
      const limit = providerLimits.get(providerId)
      if (limit !== undefined) limits[providerId] = limit
    }
    return Object.keys(limits).length === 0 ? null : limits
  }

  const isProviderQuotaBlocked = (providerId: string): boolean => {
    const block = quotaBlocks.get(providerId)
    if (block === undefined) return false
    if (block.until > Date.now()) return true
    quotaBlocks.delete(providerId)
    void store.clearProviderBlock(providerId).catch(() => undefined)
    return false
  }

  // Usage probes: providers that publish per-account meter windows (opencode's
  // GET {baseUrl}/usage) let exhausted accounts be blocked BEFORE an HTTP
  // attempt is spent, with the API-reported reset instead of a billing
  // estimate. Probing is best-effort; any failure falls back to the reactive
  // billing-mark path below.
  const usageCache = new UsageProbeCache()
  const probeBlocks = new Map<string, number>()

  const providerUsageProbe = (
    providerId: string,
  ): { integration: AnyIntegration; provider: Provider<Api>; probe: UsageProbe } | undefined => {
    const integration = effectiveIntegration(providerId)
    if (integration === undefined) return undefined
    const provider = baseProviders.get(providerId)
      ?? installedProviders.get(providerId)
      ?? (currentContext?.modelRegistry.getProvider(providerId) as Provider<Api> | undefined)
    const url = detectUsageUrl(provider?.getModels()[0]?.baseUrl)
    if (provider === undefined || url === undefined) return undefined
    return { integration, provider, probe: createHttpUsageProbe(url) }
  }

  // Refresh (respecting the TTL unless forced) every account of a
  // probe-capable provider and block exhausted accounts until their reported
  // reset. Returns undefined when the provider has no usable probe.
  const probeAccountsUsage = async (
    providerId: string,
    force: boolean,
  ): Promise<{ until: number; allLimited: boolean } | undefined> => {
    const capable = providerUsageProbe(providerId)
    if (capable === undefined) return undefined
    const { integration, provider, probe } = capable
    let accounts
    try {
      accounts = await integration.accounts()
    } catch {
      return undefined
    }
    const model = provider.getModels()[0]
    if (model === undefined) return undefined
    const now = Date.now()
    let until: number | undefined
    let probedCount = 0
    let limitedCount = 0
    for (const account of accounts) {
      let token: string | undefined
      try {
        const signal = AbortSignal.timeout(10_000)
        const resolution = await integration.resolveAuth(account, signal, {
          provider,
          model,
          context: normalizeContext({ messages: [] }),
          requestOptions: {},
          signal,
        })
        token = bearerTokenFromAuth(resolution)
      } catch {
        continue
      }
      if (token === undefined) continue
      const snapshot = await usageCache.refresh(providerId, account.id, probe, token, force)
      if (snapshot === undefined) continue
      probedCount += 1
      if (!snapshot.isLimited) continue
      limitedCount += 1
      const resets = snapshot.windows
        .filter(window => window.rateLimited)
        .map(window => window.resetsAt ?? now + (USAGE_WINDOW_FALLBACK_MS[window.key] ?? USAGE_WINDOW_FALLBACK_MS.rolling!))
      const accountUntil = resets.length === 0 ? undefined : Math.min(...resets)
      if (accountUntil === undefined) continue
      service.coolAccountUntil(providerId, account.id, accountUntil)
      const key = providerId + VIRTUAL_ID_SEPARATOR + account.id
      if ((probeBlocks.get(key) ?? 0) <= now) {
        currentContext?.ui.notify(
          `multiprovider: account "${account.label ?? account.id}" on "${providerId}" is out of usage until ${new Date(accountUntil).toLocaleString()}`,
          'warning',
        )
      }
      probeBlocks.set(key, accountUntil)
      until = until === undefined ? accountUntil : Math.min(until, accountUntil)
    }
    // Prune expired notification keys so a fresh exhaustion re-notifies.
    for (const [key, blockedUntil] of probeBlocks) {
      if (blockedUntil <= now) probeBlocks.delete(key)
    }
    if (probedCount === 0) return undefined
    return until === undefined
      ? undefined
      : { until, allLimited: limitedCount === probedCount }
  }

  // Slow cadence poll so exhausted accounts are held out of selection before
  // the next request pays for the attempt.
  const probeTimer = setInterval(() => {
    for (const providerId of new Set([...managedIntegrations.keys(), ...externalIntegrations.keys()])) {
      if (providerUsageProbe(providerId) === undefined) continue
      void probeAccountsUsage(providerId, false).catch(() => undefined)
    }
  }, 60_000)
  probeTimer.unref?.()

  const flagProviderQuotaBlock = async (providerId: string, failure: ProviderAttemptFailure): Promise<void> => {
    if ((quotaBlocks.get(providerId)?.until ?? 0) > Date.now()) return
    // Prefer the provider's own usage probe when one exists: it names the
    // exhausted accounts exactly and blocks them until the reported reset.
    const probed = await probeAccountsUsage(providerId, true).catch(() => undefined)
    if (probed !== undefined) {
      if (probed.allLimited) {
        const reason = failure.message.slice(0, 300)
        quotaBlocks.set(providerId, { until: probed.until, reason })
        try {
          await store.blockProvider(providerId, probed.until, reason)
          currentContext?.ui.notify(
            `multiprovider: provider "${providerId}" is quota-blocked until ${new Date(probed.until).toLocaleString()} (usage probe)`,
            'warning',
          )
        } catch {
          // Persistence is best-effort; the in-memory block still applies.
        }
      }
      return
    }
    const policy = providerBilling.get(providerId)
    const until = policy === undefined
      ? Date.now() + SCHEDULER_DEFAULTS.quotaCooldownMs
      : computeResetAt(policy, Date.now())
    const reason = failure.message.slice(0, 300)
    quotaBlocks.set(providerId, { until, reason })
    try {
      await store.blockProvider(providerId, until, reason)
      currentContext?.ui.notify(
        `multiprovider: provider "${providerId}" is quota-blocked until ${new Date(until).toLocaleString()}`
          + (policy === undefined ? '' : ` (${policy.kind} billing)`),
        'warning',
      )
    } catch {
      // Persistence is best-effort; the in-memory block still applies.
    }
  }

  // A rejected (provider, model, level) triple. The level is part of the key
  // on purpose: a backend that refuses `max` is still perfectly usable at
  // `low`, and a flat pair key used to evict it from the pool for every level
  // for the rest of the process — which made an unbiased pool look like it was
  // ignoring its strategy. A rejection with no thinking level in play means the
  // upstream refuses reasoning control outright, so no level is worth trying.
  const flagKey = (providerId: string, modelId: string, level: ModelThinkingLevel | undefined): string =>
    providerId + VIRTUAL_ID_SEPARATOR + modelId + VIRTUAL_ID_SEPARATOR + (level ?? 'any')

  const isFlaggedAt = (
    providerId: string,
    modelId: string,
    level: ModelThinkingLevel | undefined,
  ): boolean =>
    flaggedBackends.has(flagKey(providerId, modelId, undefined))
    || (level !== undefined && flaggedBackends.has(flagKey(providerId, modelId, level)))

  // Levels a pair is known to reject, for surfaces that list backends.
  const flaggedLevelsFor = (providerId: string, modelId: string): string[] => {
    const prefix = providerId + VIRTUAL_ID_SEPARATOR + modelId + VIRTUAL_ID_SEPARATOR
    const levels: string[] = []
    for (const key of flaggedBackends) {
      if (!key.startsWith(prefix)) continue
      levels.push(key.slice(prefix.length))
    }
    return levels.sort()
  }

  const flagBackendIncompatible = (
    providerId: string,
    modelId: string,
    level: ModelThinkingLevel | undefined,
    failure: ProviderAttemptFailure,
  ): void => {
    const key = flagKey(providerId, modelId, level)
    if (flaggedBackends.has(key)) return
    flaggedBackends.add(key)
    currentContext?.ui.notify(
      BACKEND_INCOMPATIBLE_PREFIX + ': "' + providerId + '/' + modelId + '" flagged for '
        + (level === undefined ? 'any thinking level' : 'level "' + level + '"')
        + ' this session — ' + failure.message.slice(0, 160),
      'warning',
    )
  }
  const externalIntegrations = new Map<string, AnyIntegration>()
  const managedIntegrations = new Map<string, AnyIntegration>()
  const managedBases = new Map<string, Provider<Api>>()
  const baseProviders = new Map<string, Provider<Api>>()
  const installedProviders = new Map<string, Provider<Api>>()
  const registeredIntegrations = new Map<string, AnyIntegration>()
  const unregisterSchedulers = new Map<string, () => void>()
  const warnedMissing = new Set<string>()
  const warnedOverlap = new Set<string>()
  const virtualConfigs = new Map<string, VirtualProviderConfig>()
  const virtualProviders = new Map<string, Provider<Api>>()
  const virtualIntegrations = new Map<string, ProviderRegistration<VirtualBackendRef>>()
  let currentContext: ExtensionContext | undefined
  let pendingSessionPins: SessionPin[] = []
  let pendingInheritedSessionPins: InheritedSessionPin[] = []

  // Serving line: pi's footer names the selected model, and for a virtual
  // provider that name is a stable alias — the backing provider actually
  // dispatched would otherwise be invisible. One line above the editor names
  // who serves the turn, refreshed at dispatch time (so a failover repaints).
  const SERVING_WIDGET_KEY = 'multiprovider:serving'
  interface ServedBackend {
    providerId: string
    modelId: string
    accountId?: string
    requestedLevel?: ModelThinkingLevel
    servedLevel?: ModelThinkingLevel
  }

  // ---- shared session attachments -----------------------------------------
  //
  // Scheduler affinity is in-memory and per process, so a picker in one terminal
  // tab cannot see the sessions other tabs are running — every row reads "no
  // sessions" even with three of them streaming. Each dispatch mirrors this
  // session's attachment into the shared store so the list is cross-process.
  const attachmentWrites = new Map<string, { accountId: string; at: number }>()

  const attachmentTrackKey = (poolId: string, key: string): string =>
    poolId + VIRTUAL_ID_SEPARATOR + key

  const recordAttachment = async (
    poolId: string,
    key: string,
    accountId: string,
    label: string | undefined,
    explicit: boolean,
  ): Promise<void> => {
    if (key === '') return
    const trackKey = attachmentTrackKey(poolId, key)
    try {
      await store.recordSessionAttachment(poolId, key, {
        accountId,
        ...(label === undefined ? {} : { label }),
        explicit,
      })
      attachmentWrites.set(trackKey, { accountId, at: Date.now() })
      // The write just changed what a refresh would read.
      attachmentCache.delete(poolId)
    } catch {
      // The local scheduler stays authoritative for this process; a failed
      // mirror only costs other processes a row they will not see yet.
      attachmentWrites.delete(trackKey)
    }
  }

  // Throttled mirror of a dispatch's pin. An unchanged attachment is rewritten
  // only often enough to keep its row alive, never once per turn.
  const recordServedAttachment = (info: VirtualServedInfo): void => {
    const key = info.affinityKey
    if (key === undefined || key === '') return
    const poolId = virtualSchedulerId(info.virtualProviderId, info.virtualModelId)
    const accountId = virtualBackendAccountId({ providerId: info.providerId, modelId: info.modelId })
    const prior = attachmentWrites.get(attachmentTrackKey(poolId, key))
    const now = Date.now()
    if (prior !== undefined && prior.accountId === accountId && now - prior.at < SESSION_ATTACHMENT_REFRESH_MS) {
      return
    }
    const label = (baseProviders.get(info.providerId)?.name
      ?? installedProviders.get(info.providerId)?.name
      ?? info.providerId) + ' · ' + info.modelId
    void recordAttachment(poolId, key, accountId, label, service.getAffinity(poolId, key)?.explicit === true)
  }

  // Latest attachment view per pool, kept warm for synchronous surfaces: the
  // virtual-pool editor builds its menu without an await point. Local pins are
  // always included, so a cold cache degrades to this-process truth rather than
  // to nothing.
  const attachmentCache = new Map<string, AffinityEntry[]>()

  // Backend load as of the last scheduler snapshot, for rows that cannot await
  // one. A cold entry omits the load rather than showing a stale number.
  const loadCache = new Map<string, { inFlight: number; maxConcurrent?: number }>()
  const groupLoadCache = new Map<string, Map<string, { inFlight: number; limit?: number }>>()

  const refreshLoadCache = async (): Promise<void> => {
    const snapshot = await service.snapshot()
    loadCache.clear()
    groupLoadCache.clear()
    for (const pool of snapshot.providers) {
      const byGroup = new Map<string, { inFlight: number; limit?: number }>()
      for (const account of pool.accounts) {
        loadCache.set(pool.id + VIRTUAL_ID_SEPARATOR + account.id, {
          inFlight: account.inFlight,
          ...(account.maxConcurrent === undefined ? {} : { maxConcurrent: account.maxConcurrent }),
        })
        if (account.group === undefined) continue
        const group = byGroup.get(account.group) ?? { inFlight: 0 }
        group.inFlight += account.inFlight
        byGroup.set(account.group, group)
      }
      for (const [key, limit] of Object.entries(pool.groupLimits ?? {})) {
        const group = byGroup.get(key) ?? { inFlight: 0, limit }
        group.limit = limit
        byGroup.set(key, group)
      }
      groupLoadCache.set(pool.id, byGroup)
    }
  }

  // A bare in-flight count says nothing without the ceiling it is measured
  // against, so an uncapped backend shows no load column at all.
  const cachedLoad = (poolId: string, accountId: string): string | undefined => {
    const entry = loadCache.get(poolId + VIRTUAL_ID_SEPARATOR + accountId)
    if (entry === undefined || entry.maxConcurrent === undefined) return undefined
    return `${entry.inFlight}/${entry.maxConcurrent} in flight`
  }

  const cachedGroupLoad = (poolId: string, providerId: string): string | undefined => {
    const entry = groupLoadCache.get(poolId)?.get(providerId)
    if (entry === undefined || entry.limit === undefined) return undefined
    return `${entry.inFlight}/${entry.limit} in flight`
  }

  const refreshAttachmentCache = async (poolIds: readonly string[]): Promise<void> => {
    if (poolIds.length === 0) return
    const local = new Map(poolIds.map(poolId =>
      [poolId, service.affinityEntries(poolId)] as const))
    let mirrored: SessionAttachmentEntry[] = []
    try {
      mirrored = await store.listSessionAttachments()
    } catch {
      // One read failure must not blank the list; fall back to local rows.
    }
    for (const poolId of poolIds) {
      attachmentCache.set(poolId, mergeAttachments(local.get(poolId) ?? [], mirrored, poolId))
    }
  }

  const cachedAttachments = (poolId: string): AffinityEntry[] =>
    attachmentCache.get(poolId) ?? service.affinityEntries(poolId)

  // Local pins plus every other process's mirrored rows, newest first.
  const attachmentView = async (poolId: string): Promise<AffinityEntry[]> => {
    await refreshAttachmentCache([poolId])
    return cachedAttachments(poolId)
  }

  const servedBackends = new Map<string, ServedBackend>()
  const accountLabels = new Map<string, string>()
  let servingWidgetEnabled = true

  const servedKey = (virtualProviderId: string, virtualModelId: string): string =>
    virtualProviderId + VIRTUAL_ID_SEPARATOR + virtualModelId

  // The backing provider's own pool picked an account for this session; the
  // scheduler's affinity table names it. Undefined when the backing provider
  // is not pooled (no scheduler entry) or the provider id is unknown.
  const servedAccount = (providerId: string): { accountId?: string } => {
    const sessionId = currentContext?.sessionManager.getSessionId()
    if (sessionId === undefined) return {}
    try {
      const pin = service.getAffinity(providerId, sessionId)
      if (pin === undefined) return {}
      void resolveAccountLabel(providerId, pin.accountId)
      return { accountId: pin.accountId }
    } catch {
      return {}
    }
  }

  // Account labels live in the integration's account list; cache them so the
  // widget renders synchronously from a repaint.
  const resolveAccountLabel = async (providerId: string, accountId: string): Promise<void> => {
    const key = providerId + VIRTUAL_ID_SEPARATOR + accountId
    if (accountLabels.has(key)) return
    const integration = effectiveIntegration(providerId)
    if (integration === undefined) return
    try {
      for (const account of await integration.accounts()) {
        accountLabels.set(providerId + VIRTUAL_ID_SEPARATOR + account.id, account.label)
      }
    } catch {
      // A provider that cannot list accounts simply renders without a label.
      return
    }
    // The label resolved after the dispatch-time paint; refresh the line so
    // the account shows up on the turn that discovered it, not the next one.
    if (currentContext !== undefined) renderServingWidget(currentContext)
  }

  const servingLine = (ctx: ExtensionContext): string | undefined => {
    if (!servingWidgetEnabled) return undefined
    const model = ctx.model
    if (model === undefined) return undefined
    const served = servedBackends.get(servedKey(model.provider, model.id))
    if (served === undefined) return undefined
    const providerName = baseProviders.get(served.providerId)?.name
      ?? installedProviders.get(served.providerId)?.name
      ?? served.providerId
    const account = served.accountId === undefined
      ? undefined
      : accountLabels.get(served.providerId + VIRTUAL_ID_SEPARATOR + served.accountId)
    // A degraded level is worth naming: the operator asked for one thing and
    // the picked backend serves another, and that is invisible in pi's footer.
    const level = served.servedLevel === undefined || served.servedLevel === served.requestedLevel
      ? ''
      : ` · ${served.requestedLevel}→${served.servedLevel}`
    return `\u21b3 serving ${providerName} \u00b7 ${served.modelId}`
      + level
      + (account === undefined ? '' : ` \u00b7 ${account}`)
  }

  const renderServingWidget = (ctx: ExtensionContext): void => {
    try {
      const line = servingLine(ctx)
      if (line === undefined) ctx.ui.setWidget(SERVING_WIDGET_KEY, undefined)
      else ctx.ui.setWidget(SERVING_WIDGET_KEY, [line])
    } catch {
      // A stale context can surface here; the next dispatch repaints.
    }
  }

  const effectiveIntegration = (providerId: string): AnyIntegration | undefined => {
    const managed = managedIntegrations.get(providerId)
    const external = externalIntegrations.get(providerId)
    if (managed !== undefined && external !== undefined && !warnedOverlap.has(providerId)) {
      warnedOverlap.add(providerId)
      currentContext?.ui.notify(
        `multiprovider: stored accounts take precedence over the provider-owned integration for "${providerId}"`,
        'warning',
      )
    }
    return managed ?? external
  }

  // Mirrors the affinity key the lifted provider computes for each stream: the
  // integration's own key when defined, otherwise the Pi session id. Custom
  // keys are invoked with a minimal context, so keys derived from request
  // message history cannot be reproduced here and fall back to the session id.
  const sessionAffinityKey = (
    integration: AnyIntegration | ProviderRegistration<VirtualBackendRef>,
    ctx: MultiProviderServiceContext,
    model: ExtensionContext['model'],
    providerId: string,
  ): string => {
    const fallback = ctx.sessionManager.getSessionId()
    const customAffinityKey = (integration as Partial<AnyIntegration>).affinityKey
    if (customAffinityKey === undefined || model === undefined) return fallback
    const provider = baseProviders.get(providerId)
      ?? ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
    if (provider === undefined) return fallback
    try {
      return customAffinityKey({ provider, model, context: normalizeContext({ messages: [] }) }) ?? fallback
    } catch {
      return fallback
    }
  }

  // Announced on MULTIPROVIDER_SERVICE_EVENT so sibling extensions can follow
  // the session's active pooled account; re-emitted at factory load and on
  // session start with the same stable object.
  const announcement = createServiceAnnouncement({
    scheduler: service,
    getIntegration: effectiveIntegration,
    getBaseProvider: (providerId, ctx) =>
      baseProviders.get(providerId)
      ?? ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined,
    affinityKeyFor: (integration, ctx, providerId) =>
      sessionAffinityKey(integration, ctx, ctx.model, providerId),
  })

  const announceService = (): void => {
    pi.events.emit(MULTIPROVIDER_SERVICE_EVENT, announcement)
  }
  announceService()

  // Failover compaction: when a pooled account is abandoned after its final
  // tolerated error, switching to the next account resends the full request
  // context against a cold prompt cache. If pi-fabric is installed, its
  // deterministic (LLM-free) compaction engine shrinks the session during
  // the retry backoff window so the next account serves a small prefill.
  // While a compaction is scheduled, the stream surfaces the buffered error
  // instead of rotating accounts inline; the resulting retry run rebuilds
  // its context snapshot after compaction and lands on the next account.
  const FAILOVER_COMPACT_DEBOUNCE_MS = 30_000
  const FAILOVER_COMPACT_IDLE_TIMEOUT_MS = 15_000
  let lastFailoverCompactAt = 0

  const isFabricCompactionAvailable = (): boolean => {
    try {
      return pi.getAllTools().some(tool => tool.name === 'fabric_exec')
    } catch {
      return false
    }
  }

  const runFailoverCompaction = async (info: FailoverInfo): Promise<void> => {
    const ctx = currentContext
    if (ctx === undefined) return
    const startedAt = Date.now()
    if (startedAt - lastFailoverCompactAt < FAILOVER_COMPACT_DEBOUNCE_MS) return
    try {
      const pool = (await service.snapshot()).providers.find(
        candidate => candidate.id === info.providerId,
      )
      if (pool === undefined || pool.accounts.filter(account => account.enabled).length < 2) return
    } catch {
      return
    }
    // Wait out the failing run so compaction never aborts an active stream;
    // ctx.compact() aborts the current run as its first step.
    const deadline = startedAt + FAILOVER_COMPACT_IDLE_TIMEOUT_MS
    while (!ctx.isIdle() && Date.now() < deadline) {
      await new Promise(resolve => { setTimeout(resolve, 50) })
    }
    if (!ctx.isIdle() || Date.now() - lastFailoverCompactAt < FAILOVER_COMPACT_DEBOUNCE_MS) return
    lastFailoverCompactAt = Date.now()
    ctx.compact({
      onComplete: () => {
        ctx.ui.notify('multiprovider: compacted session context before account failover', 'info')
      },
      onError: () => {},
    })
  }

  const handleFailover = (info: FailoverInfo): boolean => {
    const integration = effectiveIntegration(info.providerId)
    const handled = integration?.onFailover?.(info) === true
    if (!isFabricCompactionAvailable()) return handled
    void runFailoverCompaction(info)
    return true
  }

  const restoreProvider = (providerId: string, ctx?: ExtensionContext): void => {
    const base = baseProviders.get(providerId)
    const installed = installedProviders.get(providerId)
    const current = ctx?.modelRegistry.getProvider(providerId)
    if (base !== undefined && (ctx === undefined || current === installed)) pi.registerProvider(base)
    installedProviders.delete(providerId)
    baseProviders.delete(providerId)
    registeredIntegrations.delete(providerId)
    unregisterSchedulers.get(providerId)?.()
    unregisterSchedulers.delete(providerId)
  }

  const install = async (providerId: string, ctx: ExtensionContext): Promise<void> => {
    const integration = effectiveIntegration(providerId)
    if (integration === undefined) {
      restoreProvider(providerId, ctx)
      return
    }

    const current = ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
    const priorLift = installedProviders.get(providerId)
    const base = current === priorLift ? baseProviders.get(providerId) : current
    if (base === undefined) {
      if (!warnedMissing.has(providerId)) {
        warnedMissing.add(providerId)
        ctx.ui.notify(`multiprovider: provider "${providerId}" is not registered`, 'warning')
      }
      return
    }
    warnedMissing.delete(providerId)

    if (registeredIntegrations.get(providerId) !== integration) {
      unregisterSchedulers.get(providerId)?.()
      try {
        unregisterSchedulers.set(providerId, service.registerProvider(integration))
        registeredIntegrations.set(providerId, integration)
      } catch (error) {
        ctx.ui.notify(errorText(error), 'error')
        return
      }
    }

    const managedPool = managedIntegrations.has(providerId)
      ? await store.getPool(providerId)
      : undefined
    if (managedPool !== undefined) {
      await service.updatePool(providerId, {
        policy: managedPool.policy,
        affinity: managedPool.affinity,
        groupLimits: groupLimitsFor([providerId]),
      })
    }

    if (current === priorLift && baseProviders.get(providerId) === base) return
    // A provider-owned key is a routing decision and wins outright; the host
    // session is only the last-resort identity, so a nested agent that declares
    // its own session on the stream options can scope stickiness to itself.
    const lifted = liftProvider(base, service, {
      ...integration,
      hostAffinityKey: () => ctx.sessionManager.getSessionId(),
      onFailover: handleFailover,
    })
    pi.registerProvider(lifted)
    baseProviders.set(providerId, base)
    installedProviders.set(providerId, lifted)
  }

  const refreshManaged = async (ctx: ExtensionContext): Promise<void> => {
    const storedIds = new Set(await store.listProviderIds())
    for (const providerId of [...managedIntegrations.keys()]) {
      if (storedIds.has(providerId)) continue
      managedIntegrations.delete(providerId)
      managedBases.delete(providerId)
      if (!externalIntegrations.has(providerId)) restoreProvider(providerId, ctx)
    }

    for (const providerId of storedIds) {
      const current = ctx.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
      const priorLift = installedProviders.get(providerId)
      const base = current === priorLift ? baseProviders.get(providerId) : current
      if (base === undefined) continue
      if (managedBases.get(providerId) !== base) {
        managedBases.set(providerId, base)
        managedIntegrations.set(
          providerId,
          createManagedIntegration(base, store) as AnyIntegration,
        )
      }
    }
  }

  const unregisterVirtualModels = (config: VirtualProviderConfig): void => {
    for (const model of config.models) {
      const schedulerId = virtualSchedulerId(config.id, model.id)
      unregisterSchedulers.get(schedulerId)?.()
      unregisterSchedulers.delete(schedulerId)
      virtualIntegrations.delete(schedulerId)
    }
  }

  // Virtual providers round-robin sessions across backing provider models with
  // no first-provider bias; session affinity pins a session to one backend so
  // prompt caches stay warm between hops.
  // Canonical form of a virtual config for change detection. Key order can differ
  // between the object this process holds and the one the store rewrote (a healed
  // template appends `compat` last; normalization emits it mid-object), and a
  // false mismatch here re-registers the pool — which drops every session pin in
  // this process. Compare a key-sorted form so only a real change churns.
  const canonicalConfigKey = (config: VirtualProviderConfig): string => JSON.stringify(config,
    (_key, value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map(name => [name, (value as Record<string, unknown>)[name]]))
      : value))

  const refreshVirtual = async (): Promise<void> => {
    const stored = await store.listVirtualProviders()
    const storedIds = new Set(stored.map(config => config.id))
    for (const providerId of [...virtualConfigs.keys()]) {
      if (storedIds.has(providerId)) continue
      const prior = virtualConfigs.get(providerId)
      if (prior !== undefined) unregisterVirtualModels(prior)
      virtualConfigs.delete(providerId)
      if (virtualProviders.has(providerId)) {
        pi.unregisterProvider(providerId)
        virtualProviders.delete(providerId)
      }
    }

    // Heals configs saved before backend templates were captured: once
    // backing providers are registered (install ran), resolve live metadata
    // and persist it so the next extension load snapshots virtual models with
    // correct thinking support. Best-effort; failures retry next reconcile.
    const resolveTemplate = (providerId: string, modelId: string): VirtualModelTemplate | undefined => {
      const provider = installedProviders.get(providerId)
        ?? baseProviders.get(providerId)
        ?? currentContext?.modelRegistry.getProvider(providerId) as Provider<Api> | undefined
      const model = provider?.getModels().find(item => item.id === modelId)
      return model === undefined ? undefined : captureVirtualModelTemplate(model)
    }
    for (const storedConfig of stored) {
      const healed = healVirtualTemplates(storedConfig, resolveTemplate)
      if (healed !== undefined) {
        try {
          await store.saveVirtualProvider(healed)
        } catch {
          // Template persistence is best-effort; live resolution still wins.
        }
      }
      const config = healed ?? storedConfig
      const prior = virtualConfigs.get(config.id)
      if (prior !== undefined && canonicalConfigKey(prior) === canonicalConfigKey(config)) continue
      if (prior !== undefined) unregisterVirtualModels(prior)

      // Registration runs at extension load, before any session exists; the
      // closures only dereference the context once a session is streaming.
      const sessionContext = (): ExtensionContext | undefined => currentContext
      const providerLabel = (providerId: string): string | undefined =>
        baseProviders.get(providerId)?.name
        ?? sessionContext()?.modelRegistry.getProvider(providerId)?.name

      const integrations = createVirtualIntegrations(config, { getProviderLabel: providerLabel })
      for (const integration of integrations) {
        unregisterSchedulers.get(integration.id)?.()
        unregisterSchedulers.set(integration.id, service.registerProvider(integration))
        virtualIntegrations.set(integration.id, integration)
        // The strategy and session stickiness are persisted with the config and
        // (re)applied on every load or edit; round-robin keeps the virtual pool's
        // unbiased rotation, affinity off spreads a fan-out across backends.
        await service.updatePool(integration.id, {
          policy: config.strategy ?? 'round-robin',
          // Absent keeps the pool on one flat pass; null clears a choice the
          // operator later reverted.
          groupPolicy: config.providerStrategy ?? null,
          groupLimits: groupLimitsFor([
            ...new Set(config.models.flatMap(model => model.backends.map(backend => backend.providerId))),
          ]),
          groupPriorities: config.providerPriority ?? null,
          affinity: config.affinity !== false,
        })
      }

      const virtualProvider = createVirtualProvider({
        service,
        config,
        onFailover: handleFailover,
        isProviderBlocked: isProviderQuotaBlocked,
        onBackendQuotaFailure: (providerId, failure) => { void flagProviderQuotaBlock(providerId, failure) },
        isModelFlagged: (providerId, modelId, level) => isFlaggedAt(providerId, modelId, level),
        onBackendFatalMetadata: flagBackendIncompatible,
        onBackendServed: info => {
          servedBackends.set(servedKey(info.virtualProviderId, info.virtualModelId), {
            providerId: info.providerId,
            modelId: info.modelId,
            ...(info.requestedLevel === undefined ? {} : { requestedLevel: info.requestedLevel }),
            ...(info.servedLevel === undefined ? {} : { servedLevel: info.servedLevel }),
            ...servedAccount(info.providerId),
          })
          const ctx = currentContext
          if (ctx?.model !== undefined
            && ctx.model.provider === info.virtualProviderId
            && ctx.model.id === info.virtualModelId) renderServingWidget(ctx)
          void recordServedAttachment(info)
        },
        getAffinityKey: () => sessionContext()?.sessionManager.getSessionId() ?? '',
        getBackingProvider: providerId =>
          installedProviders.get(providerId)
          ?? baseProviders.get(providerId)
          ?? sessionContext()?.modelRegistry.getProvider(providerId) as Provider<Api> | undefined,
        isBackendConfigured: providerId =>
          sessionContext()?.modelRegistry.getProviderAuthStatus(providerId).configured ?? true,
        resolveAmbientAuth: async (_providerId, model, signal) => {
          const context = sessionContext()
          if (context === undefined) return { ok: false, error: 'multiprovider: session not ready' }
          const resolution = await context.modelRegistry.getApiKeyAndHeaders(model)
          if (!resolution.ok) return { ok: false, error: resolution.error }
          return {
            ok: true,
            ...(resolution.apiKey === undefined ? {} : { apiKey: resolution.apiKey }),
            ...(resolution.headers === undefined ? {} : { headers: resolution.headers }),
            ...(resolution.baseUrl === undefined ? {} : { baseUrl: resolution.baseUrl }),
            ...(resolution.env === undefined ? {} : { env: resolution.env }),
          }
        },
      })
      pi.registerProvider(virtualProvider)
      virtualProviders.set(config.id, virtualProvider)
      virtualConfigs.set(config.id, config)
    }
  }

  // Register stored virtual providers during extension load: pi resolves
  // model patterns (enabled models, resumed session models) right after
  // extensions load and before session_start fires, so virtual models must
  // already be in the registry for session resume to find them.
  await refreshVirtual()

  // /switch-account records each explicit pin — and each return to automatic
  // selection — as a custom session entry. Resuming the session replays the
  // last decision so it keeps the operator's chosen account instead of falling
  // back to the pool strategy; account health and implicit affinity stay in
  // memory. Pools whose scheduler is not registered yet stay pending until a
  // later reconcile can apply them.
  const affinityKeyForPool = (poolId: string, ctx: ExtensionContext): string => {
    const virtual = virtualIntegrations.get(poolId)
    const integration = virtual ?? effectiveIntegration(poolId)
    if (integration === undefined) return ctx.sessionManager.getSessionId()
    const providerId = virtual !== undefined ? ctx.model?.provider ?? poolId : poolId
    return sessionAffinityKey(integration, ctx, ctx.model, providerId)
  }

  const applyRecordedPins = async (ctx: ExtensionContext): Promise<void> => {
    const restoredPools = new Set<string>()
    const pinHost = {
      hasPool: (poolId: string) => service.hasProvider(poolId),
      pin: (poolId: string, key: string, accountId: string) => service.pinAccount(poolId, key, accountId),
      clear: (poolId: string, key: string) => service.clearAffinity(poolId, key),
    }
    const onRestoreError = (pin: SessionPin, error: unknown): void => {
      const target = pin.label === undefined ? pin.accountId ?? '' : `"${pin.label}"`
      ctx.ui.notify(
        `multiprovider: pinned account ${target} could not be restored for "${pin.pool}": ${errorText(error)}`,
        'warning',
      )
    }

    if (pendingSessionPins.length > 0) {
      pendingSessionPins = await applySessionPins(
        pendingSessionPins,
        pinHost,
        onRestoreError,
        pin => restoredPools.add(pin.pool),
      )
    }

    if (pendingInheritedSessionPins.length > 0) {
      const recordedPools = new Set([
        ...pendingSessionPins.map(pin => pin.pool),
        ...sessionPinsFromEntries(ctx.sessionManager.getEntries()).map(pin => pin.pool),
      ])
      const ready: SessionPin[] = []
      const stillPending: InheritedSessionPin[] = []
      for (const pin of pendingInheritedSessionPins) {
        if (recordedPools.has(pin.pool)) continue
        if (!service.hasProvider(pin.pool)) {
          stillPending.push(pin)
          continue
        }
        ready.push({
          pool: pin.pool,
          key: affinityKeyForPool(pin.pool, ctx),
          ...(pin.accountId === undefined ? {} : { accountId: pin.accountId }),
          ...(pin.label === undefined ? {} : { label: pin.label }),
        })
      }
      const leftover = await applySessionPins(ready, pinHost, onRestoreError, pin => {
        restoredPools.add(pin.pool)
        pi.appendEntry(SESSION_PIN_ENTRY_TYPE, {
          pool: pin.pool,
          key: pin.key,
          ...(pin.accountId === undefined ? {} : { accountId: pin.accountId }),
          ...(pin.label === undefined ? {} : { label: pin.label }),
        })
      })
      pendingInheritedSessionPins = [
        ...stillPending,
        ...leftover.map(pin => ({
          pool: pin.pool,
          ...(pin.accountId === undefined ? {} : { accountId: pin.accountId }),
          ...(pin.label === undefined ? {} : { label: pin.label }),
        })),
      ]
    }

    // Followers of the session's active account — pi-better-openai's usage
    // widget, for example — re-resolve their account-scoped state from this
    // notification. Without it a resumed session keeps showing the account it
    // had before the switch until the follower's own next poll.
    for (const poolId of restoredPools) {
      const account = await announcement.getActiveAccount(poolId, ctx)
      announcement.notifyActiveAccountChanged(poolId, ctx, account)
    }
  }

  const reconcile = async (ctx: ExtensionContext): Promise<void> => {
    service.updateSchedulerDefaults(await store.getSchedulerSettings())
    await refreshVirtual()
    await refreshManaged(ctx)
    const ids = new Set([
      ...externalIntegrations.keys(),
      ...managedIntegrations.keys(),
      ...installedProviders.keys(),
    ])
    for (const providerId of ids) await install(providerId, ctx)
    await refreshVirtual()
    await applyRecordedPins(ctx)
  }

  const unsubscribeRegistration = pi.events.on(MULTIPROVIDER_REGISTER_EVENT, value => {
    if (!isIntegration(value)) return
    const existing = externalIntegrations.get(value.id)
    if (existing === value) return
    externalIntegrations.set(value.id, value)
    if (currentContext !== undefined) void install(value.id, currentContext)
  })

  pi.on('session_start', async (_event, ctx) => {
    currentContext = ctx
    pendingSessionPins = sessionPinsFromEntries(ctx.sessionManager.getEntries())
    const recordedPools = new Set(pendingSessionPins.map(pin => pin.pool))
    pendingInheritedSessionPins = inheritedSessionPinsFromEnv(process.env)
      .filter((pin: InheritedSessionPin) => !recordedPools.has(pin.pool))
    await reconcile(ctx)
    announceService()
    renderServingWidget(ctx)
  })

  // Switching models swaps the serving line to the new model's backend, or
  // clears it when the selection is not a virtual model at all.
  pi.on('model_select', (_event, ctx) => {
    currentContext = ctx
    renderServingWidget(ctx)
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    currentContext = ctx
    await reconcile(ctx)
  })

  pi.on('session_shutdown', () => {
    unsubscribeRegistration()
    for (const providerId of installedProviders.keys()) restoreProvider(providerId, currentContext)
    managedIntegrations.clear()
    managedBases.clear()
    for (const providerId of virtualProviders.keys()) pi.unregisterProvider(providerId)
    virtualProviders.clear()
    virtualIntegrations.clear()
    virtualConfigs.clear()
    pendingSessionPins = []
    pendingInheritedSessionPins = []
    servedBackends.clear()
    accountLabels.clear()
    currentContext = undefined
  })

  pi.registerCommand('serving', {
    description: 'Show or hide the line naming which backing provider serves this virtual model',
    handler: async (args, ctx) => {
      currentContext = ctx
      const arg = args.trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        servingWidgetEnabled = arg === 'on'
        renderServingWidget(ctx)
        ctx.ui.notify(servingWidgetEnabled
          ? 'multiprovider: serving line enabled.'
          : 'multiprovider: serving line hidden — bring it back with /serving on.', 'info')
        return
      }
      const line = servingLine(ctx)
      ctx.ui.notify(line === undefined
        ? 'multiprovider: no virtual backend has served this session yet — select a virtual model and send a message.'
        : `multiprovider: ${line}`, 'info')
    },
  })

  pi.registerCommand('multilogin', {
    description: 'Manage a provider pool, Pi default auth, schedulers, and accounts',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/multilogin requires Pi interactive mode.', 'warning')
        return
      }
      await reconcile(ctx)
      const providers = uniqueProviders(ctx, baseProviders)
        .filter(provider => !virtualProviders.has(provider.id))
      const selection = await selectLogin(ctx, providers, args.trim() || undefined)
      if (selection === undefined) return
      const provider = selection.provider

      interface BufferedPool {
        policy: SelectionPolicy
        affinity: boolean
        includeUpstream: boolean
        upstream: MultiAuthUpstreamPreferences
      }
      const initialPool = await store.getPool(provider.id)
      let buffer: BufferedPool = {
        policy: initialPool?.policy ?? 'round-robin',
        affinity: initialPool?.affinity ?? true,
        includeUpstream: initialPool?.includeUpstream ?? true,
        upstream: { ...(initialPool?.upstream ?? {}) },
      }

      const callbacks: PoolManagerCallbacks = {
        async loadState() {
          const pool = await store.getPool(provider.id)
          const scheduler = await store.getSchedulerSettings()
          const runtime = probeSessionRuntime(ctx)
          const upstreamStatus = runtime?.getProviderAuthStatus(provider.id)
          const upstreamConfigured = upstreamStatus !== undefined && upstreamStatus.configured
          const upstreamSource = upstreamConfigured ? (upstreamStatus.label ?? upstreamStatus.source) : undefined
          const upstreamState = {
            ...(upstreamConfigured ? { upstreamConfigured } : {}),
            ...(upstreamSource === undefined ? {} : { upstreamSource }),
          }
          if (pool === undefined) {
            return {
              poolExists: false,
              policy: buffer.policy,
              affinity: buffer.affinity,
              includeUpstream: buffer.includeUpstream,
              upstream: { ...buffer.upstream },
              accounts: [],
              scheduler,
              ...upstreamState,
            }
          }
          buffer = {
            policy: pool.policy,
            affinity: pool.affinity,
            includeUpstream: pool.includeUpstream,
            upstream: { ...(pool.upstream ?? {}) },
          }
          return {
            poolExists: true,
            policy: pool.policy,
            affinity: pool.affinity,
            includeUpstream: pool.includeUpstream,
            upstream: { ...(pool.upstream ?? {}) },
            accounts: pool.accounts,
            scheduler,
            ...upstreamState,
          }
        },
        async updatePool(settings) {
          if (await store.getPool(provider.id) === undefined) {
            if (settings.policy !== undefined) buffer.policy = settings.policy
            if (settings.affinity !== undefined) buffer.affinity = settings.affinity
            if (settings.includeUpstream !== undefined) buffer.includeUpstream = settings.includeUpstream
            if (settings.upstream !== undefined) buffer.upstream = { ...settings.upstream }
            return
          }
          await store.updatePool(provider.id, settings)
          await reconcile(ctx)
        },
        async updateAccount(accountId, settings) {
          await store.updateAccount(provider.id, accountId, settings)
          await reconcile(ctx)
        },
        async removeAccount(accountId) {
          await store.removeAccount(provider.id, accountId)
          await reconcile(ctx)
        },
        async updateScheduler(key, valueMs) {
          const patch: SchedulerSettingsPatch = { [key]: valueMs }
          const effective = await store.updateSchedulerSettings(patch)
          service.updateSchedulerDefaults(effective)
        },
      }

      const methods: PoolManagerAuthMethod[] = []
      if (provider.auth.oauth?.login !== undefined) {
        methods.push({ label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name, value: 'oauth' })
      }
      if (provider.auth.apiKey !== undefined) {
        const interactive = provider.auth.apiKey.login !== undefined
        const keyName = provider.auth.apiKey.name
        const baseLabel = keyName === 'API key' ? 'API key' : `API key · ${keyName}`
        methods.push({
          label: interactive ? baseLabel : `${baseLabel} (paste)`,
          value: interactive ? 'api_key' : 'api_key_paste',
        })
      }

      const runLogin = async (method: string, title?: string) =>
        method === 'api_key_paste'
          ? await promptApiKeyCredential(ctx, provider)
          : await showLoginDialog(
              ctx,
              { provider, authType: method as AuthType },
              title === undefined ? {} : { title },
            )

      let result = await openPoolManager(ctx, provider, callbacks, methods)
      while (result.type === 'add' || result.type === 'reauth') {
        if (result.type === 'reauth') {
          const reauthAccountId = result.accountId
          const pool = await store.getPool(provider.id)
          const account = pool?.accounts.find(candidate => candidate.id === reauthAccountId)
          if (account === undefined) {
            ctx.ui.notify('That account is no longer stored.', 'warning')
          } else {
            const login = await runLogin(result.method, `Reauthenticate ${account.label}`)
            if (login !== undefined && 'error' in login) {
              ctx.ui.notify(`Failed to reauthenticate ${account.label}: ${login.error.message}`, 'error')
            } else if (login !== undefined) {
              let credential: Credential | undefined = login.credential
              try {
                await store.replaceAccountCredential(provider.id, account.id, credential)
                credential = undefined
                if (service.hasProvider(provider.id)) service.resetHealth(provider.id, account.id)
                await reconcile(ctx)
                ctx.ui.notify(
                  `Reauthenticated ${account.label} for ${provider.name}. Credentials saved to ${getMultiAuthPath()}`,
                  'info',
                )
              } catch (error) {
                credential = undefined
                ctx.ui.notify(`Could not replace account credentials: ${errorText(error)}`, 'error')
              }
            }
          }
        } else {
          const method = result.method
          const existing = await store.getPool(provider.id)
          const defaultLabel = `${provider.name} ${(existing?.accounts.length ?? 0) + 1}`
          const labelInput = await ctx.ui.input('Account label:', defaultLabel)
          if (labelInput !== undefined) {
            const label = labelInput.trim() || defaultLabel
            const login = await runLogin(method)
            if (login !== undefined && 'error' in login) {
              ctx.ui.notify(`Failed to authenticate ${provider.name}: ${login.error.message}`, 'error')
            } else if (login !== undefined) {
              let credential: Credential | undefined = login.credential
              try {
                await store.addAccount(provider.id, {
                  label,
                  credential,
                  ...(await store.getPool(provider.id) === undefined
                    ? {
                        pool: {
                          policy: buffer.policy,
                          affinity: buffer.affinity,
                          includeUpstream: buffer.includeUpstream,
                          upstream: buffer.upstream,
                        },
                      }
                    : {}),
                })
                credential = undefined
                await reconcile(ctx)
                ctx.ui.notify(
                  `Added ${label} to ${provider.name}. Credentials saved to ${getMultiAuthPath()}`,
                  'info',
                )
              } catch (error) {
                credential = undefined
                ctx.ui.notify(`Could not save account: ${errorText(error)}`, 'error')
              }
            }
          }
        }
        result = await openPoolManager(ctx, provider, callbacks, methods)
      }
    },
  })

  pi.registerCommand('multilogout', {
    description: 'Remove an account saved by /multilogin',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/multilogout requires Pi interactive mode.', 'warning')
        return
      }
      const pools = (await Promise.all(
        (await store.listProviderIds()).map(providerId => store.getPool(providerId)),
      )).filter(pool => pool !== undefined)
      if (pools.length === 0) {
        ctx.ui.notify('No multilogin accounts are stored.', 'info')
        return
      }
      const ref = args.trim().toLowerCase()
      let pool = ref === ''
        ? undefined
        : pools.find(candidate => candidate.providerId.toLowerCase() === ref)
      if (pool === undefined) {
        const labels = pools.map(candidate => {
          const provider = baseProviders.get(candidate.providerId)
          return `${provider?.name ?? candidate.providerId} (${candidate.accounts.length})`
        })
        const selected = await ctx.ui.select('Select provider to remove an account from:', labels)
        const index = labels.indexOf(selected ?? '')
        if (index < 0) return
        pool = pools[index]
      }
      if (pool === undefined) return
      const accountLabels = pool.accounts.map(account => `${account.label} · ${account.authKind}`)
      const selectedAccount = await ctx.ui.select('Select account to remove:', accountLabels)
      const accountIndex = accountLabels.indexOf(selectedAccount ?? '')
      if (accountIndex < 0) return
      const account = pool.accounts[accountIndex]
      if (account === undefined) return
      const confirmation = await ctx.ui.confirm(
        'Remove pooled account?',
        `Remove ${account.label} from ${pool.providerId}? Pi's normal /login credential is unchanged.`,
      )
      if (!confirmation) return
      await store.removeAccount(pool.providerId, account.id)
      await reconcile(ctx)
      ctx.ui.notify(`Removed ${account.label} from ${pool.providerId}.`, 'info')
    },
  })

  pi.registerCommand('accounts', {
    description: 'Show multiprovider account pools and health',
    handler: async (_args, ctx) => {
      await reconcile(ctx)
      const snapshot = await service.snapshot()
      if (snapshot.providers.length === 0) {
        ctx.ui.notify('No account pools are configured. Use /multilogin to add one.', 'info')
        return
      }
      await ctx.ui.select('Provider Accounts', statusLines(snapshot, (providerId, accountId) => {
        const found = usageCache.snapshots(providerId).find(item => item.accountId === accountId)
        return found === undefined ? undefined : formatUsageSummary(found.snapshot)
      }))
    },
  })

  // Everything the switch command needs about the current model's pool, resolved
  // identically for the interactive menu, a typed argument, and the editor's
  // argument completions. Failures come back as a message so each surface
  // decides how loudly to report it — a completion list stays silent, the
  // command explains.
  interface SwitchTarget {
    poolId: string
    providerName: string
    pool: PublicPoolSnapshot
    switchable: PublicAccountSnapshot[]
    affinityKey: string
    currentId: string | undefined
  }

  const resolveSwitchTarget = async (ctx: ExtensionContext): Promise<SwitchTarget | { message: string }> => {
    const model = ctx.model
    if (model === undefined) return { message: 'No model is selected.' }
    const providerId = model.provider
    const virtual = virtualIntegrations.get(virtualSchedulerId(providerId, model.id))
    const integration = virtual ?? effectiveIntegration(providerId)
    const poolId = virtual !== undefined ? virtual.id : providerId
    const providerName = virtual !== undefined
      ? `${virtualProviders.get(providerId)?.name ?? providerId} · ${model.name}`
      : ctx.modelRegistry.getProvider(providerId)?.name ?? providerId
    const pool = integration === undefined
      ? undefined
      : (await service.snapshot()).providers.find(candidate => candidate.id === poolId)
    if (integration === undefined) {
      // No stored pool exists: ambient auth (Pi /login, auth.json, environment)
      // still resolves per request, there is just nothing to switch between.
      const configured = probeSessionRuntime(ctx)?.getProviderAuthStatus(providerId)?.configured !== false
      return {
        message: `${providerName} has no multiprovider pool. ${
          configured
            ? 'Its ambient credential (Pi /login, auth.json, or environment) is used directly.'
            : 'No ambient credential is configured either.'
        } Run /multilogin ${poolId} to add pooled accounts.`,
      }
    }
    const accounts = pool?.accounts ?? []
    if (pool === undefined || accounts.length === 0) {
      return { message: `${providerName} has an empty pool. Use /multilogin to add one.` }
    }
    // The upstream account is excluded from attempts while Pi has no credential
    // configured for it, so pinning it then would never apply.
    const upstreamConfigured = probeSessionRuntime(ctx)
      ?.getProviderAuthStatus(providerId)?.configured !== false
    const switchable = accounts.filter(account =>
      account.id !== PI_UPSTREAM_ACCOUNT_ID || upstreamConfigured)
    if (switchable.length === 0) {
      return { message: `No switchable accounts for ${providerName}. Use /multilogin to add one.` }
    }
    const affinityKey = sessionAffinityKey(integration, ctx, model, providerId)
    const pin = service.getAffinity(poolId, affinityKey)
    const currentId = pin !== undefined && (pool.affinity || pin.explicit) ? pin.accountId : undefined
    return { poolId, providerName, pool, switchable, affinityKey, currentId }
  }

  const switchAccountCompletions = async (argumentPrefix: string) => {
    const ctx = currentContext
    if (ctx === undefined) return null
    const target = await resolveSwitchTarget(ctx)
    if ('message' in target) return null
    const items = pickSuggestions({
      candidates: target.switchable.map(account => ({
        id: account.id,
        label: account.label,
        detail: account.id === PI_UPSTREAM_ACCOUNT_ID
          ? 'upstream'
          : account.status === 'cooldown' ? 'cooling down' : account.authKind,
      })),
      pins: await attachmentView(target.poolId),
      currentKey: target.affinityKey,
      currentId: target.currentId,
      policy: target.pool.policy,
    })
    const normalized = argumentPrefix.trim().toLowerCase()
    if (normalized === '') return items
    return items.filter(item => item.label.toLowerCase().startsWith(normalized))
  }

  pi.registerCommand('switch-account', {
    description: 'Switch the pooled account used by the current model for this session',
    handler: async (args, ctx) => {
      await reconcile(ctx)
      const target = await resolveSwitchTarget(ctx)
      if ('message' in target) {
        ctx.ui.notify(target.message, 'info')
        return
      }
      const { poolId, providerName, pool, switchable, affinityKey, currentId } = target
      // Sibling extensions following the active account (usage widgets and the
      // like) re-resolve their account-scoped state from this notification.
      const announceSwitch = async (): Promise<void> => {
        const account = await announcement.getActiveAccount(poolId, ctx)
        announcement.notifyActiveAccountChanged(poolId, ctx, account)
      }

      const ref = args.trim()
      let automatic = false
      let earlyPick = false
      let chosen: PublicAccountSnapshot | undefined
      if (ref !== '') {
        const normalized = ref.toLowerCase()
        if (normalized === PICK_STRATEGY_REF) earlyPick = true
        else {
          let matches = switchable.filter(account => account.label.toLowerCase() === normalized)
          if (matches.length === 0) {
            matches = switchable.filter(account => account.label.toLowerCase().startsWith(normalized))
          }
          if (matches.length === 1) chosen = matches[0]
          else if (matches.length === 0 && AUTOMATIC_SWITCH_REFS.has(normalized)) automatic = true
          else if (matches.length > 1) {
            ctx.ui.notify(`Multiple accounts match "${ref}". Pick one below.`, 'warning')
          } else {
            ctx.ui.notify(`No pooled account for ${providerName} matches "${ref}". Pick one below.`, 'warning')
          }
        }
      }

      if (!automatic && !earlyPick && chosen === undefined) {
        // No UI means no menu to pick from, but an early pick still works: with
        // no argument at all, run the pool's own strategy rather than telling a
        // headless or RPC host that the command needs a terminal.
        if (!ctx.hasUI) {
          earlyPick = true
        } else {
          const pins = await attachmentView(poolId)
          const labels = [
            `Automatic · let the ${strategyLabel(pool)} strategy pick the next account`,
            `Pick now · run the ${strategyLabel(pool)} strategy and keep the result`,
            ...switchAccountLabels(switchable, currentId, accountId =>
              sessionsOn(pins, accountId, affinityKey)),
          ]
          const selected = await ctx.ui.select(`Switch ${providerName} account:`, labels)
          const index = labels.indexOf(selected ?? '')
          if (index < 0) return
          if (index === 0) automatic = true
          else if (index === 1) earlyPick = true
          else chosen = switchable[index - 2]
        }
      }

      if (automatic) {
        service.clearAffinity(poolId, affinityKey)
        // Withdraw the mirrored row too, or other processes keep showing a
        // session that has just gone automatic.
        void store.clearSessionAttachment(poolId, affinityKey)
          .then(() => attachmentCache.delete(poolId))
          .catch(() => undefined)
        attachmentWrites.delete(poolId + VIRTUAL_ID_SEPARATOR + affinityKey)
        pi.appendEntry(SESSION_PIN_ENTRY_TYPE, { pool: poolId, key: affinityKey })
        await announceSwitch()
        ctx.ui.notify(
          pool.affinity
            ? "Cleared this session's pinned account. The next request re-selects using the pool strategy."
            : 'Selection for this session is already automatic.',
          'info',
        )
        return
      }

      if (earlyPick) {
        // Early pick: let the pool's configured strategy decide now instead of
        // waiting for the next request to pin whatever it happens to choose.
        // The probe lease is released as cancelled, so a request that never
        // happened records no health against the account.
        const picked = await service.acquire({ providerId: poolId })
        const pickedAccountId = picked.accountId
        const pickedLabel = picked.account.label
        picked.release()
        try {
          await service.pinAccount(poolId, affinityKey, pickedAccountId)
        } catch (error) {
          ctx.ui.notify(`Could not pin the picked account: ${errorText(error)}`, 'error')
          return
        }
        pi.appendEntry(SESSION_PIN_ENTRY_TYPE, {
          pool: poolId,
          key: affinityKey,
          accountId: pickedAccountId,
          label: pickedLabel,
        })
        await announceSwitch()
        const attached = sessionsOn(await attachmentView(poolId), pickedAccountId, affinityKey)
        ctx.ui.notify(
          `multiprovider: the ${strategyLabel(pool)} strategy picked ${pickedLabel} for this session`
            + ` (${attached ?? 'first session here'}).`,
          'info',
        )
        return
      }

      const account = chosen
      if (account === undefined) return
      if (!account.enabled) {
        ctx.ui.notify(`Account "${account.label}" is disabled. Enable it in /multilogin first.`, 'error')
        return
      }
      try {
        await service.pinAccount(poolId, affinityKey, account.id)
      } catch (error) {
        ctx.ui.notify(`Could not switch account: ${errorText(error)}`, 'error')
        return
      }
      // Recorded so a resumed session re-applies the switch instead of falling
      // back to the pool strategy.
      pi.appendEntry(SESSION_PIN_ENTRY_TYPE, {
        pool: poolId,
        key: affinityKey,
        accountId: account.id,
        label: account.label,
      })
      // Mirror immediately: an explicit switch is a decision other processes
      // should see before this session's next request, not after it.
      void recordAttachment(poolId, affinityKey, account.id, account.label, true)
      await announceSwitch()
      const cooldown = account.cooldownUntil === undefined
        ? ''
        : ` It cools down until ${new Date(account.cooldownUntil).toLocaleTimeString()}; other accounts serve until it recovers.`
      ctx.ui.notify(
        `Switched to ${account.label} for this session. Pool settings are unchanged; new requests from this session use it.${cooldown}`,
        'info',
      )
    },
    getArgumentCompletions: (argumentPrefix: string) => switchAccountCompletions(argumentPrefix),
  })

  pi.registerCommand('vprovider', {
    description: 'Create virtual providers that map one model across multiple provider models',
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify('/vprovider requires Pi interactive mode.', 'warning')
        return
      }
      await reconcile(ctx)
      const stored = await store.listVirtualProviders()
      const candidates = uniqueProviders(ctx, baseProviders)
        .filter(provider => !virtualProviders.has(provider.id) && provider.getModels().length > 0)
      // One shared-store read warms every pool the editor can show, so its rows
      // report sessions from other processes rather than only this one.
      await refreshAttachmentCache(stored.flatMap(config =>
        config.models.map(model => virtualSchedulerId(config.id, model.id))))
      await refreshLoadCache().catch(() => undefined)
      const ref = args.trim().toLowerCase()
      const existing = ref === '' ? undefined : stored.find(candidate => candidate.id.toLowerCase() === ref)
      const outcome = await ctx.ui.custom<VirtualEditorOutcome>(
        (_tui, theme, _keybindings, done) => new VirtualProviderEditorDialog({
          theme,
          stored,
          candidates,
          isProviderIdAvailable: id => !virtualProviders.has(id) && ctx.modelRegistry.getProvider(id) === undefined,
          startDraft: existing === undefined ? undefined : structuredClone(existing),
          providerBilling: providerId => providerBilling.get(providerId),
          providerLimit: providerId => providerLimits.get(providerId),
          providerLoad: cachedGroupLoad,
          providerBlockUntil: providerId => quotaBlocks.get(providerId)?.until,
          accountUsage: providerId => {
            const snapshots = usageCache.snapshots(providerId)
            if (snapshots.length === 0) return undefined
            // Most constrained account: the one with the least remaining
            // budget anywhere, so a row summarizes the pool's worst case.
            const worst = snapshots
              .map(({ snapshot }) => ({
                snapshot,
                remaining: Math.min(...snapshot.windows.map(window => window.remainingPercent)),
              }))
              .sort((left, right) => left.remaining - right.remaining)[0]!
            return formatUsageSummary(worst.snapshot)
          },
          flaggedLevels: (providerId, modelId) => flaggedLevelsFor(providerId, modelId),
          poolAttachments: cachedAttachments,
          backendLoad: cachedLoad,
          currentSessionKey: () => currentContext?.sessionManager.getSessionId() ?? '',
          clearProviderBlock: providerId => {
            quotaBlocks.delete(providerId)
            void store.clearProviderBlock(providerId).catch(() => undefined)
          },
          done,
        }),
      )
      if (outcome === undefined || outcome.kind === 'dismissed' || outcome.kind === 'discarded') return
      if (outcome.kind === 'removed') {
        const confirmed = await ctx.ui.confirm(
          'Remove virtual provider?',
          `Remove ${outcome.id}? Backing providers and their pooled accounts are untouched.`,
        )
        if (!confirmed) return
        await store.removeVirtualProvider(outcome.id)
        await reconcile(ctx)
        ctx.ui.notify(`Removed virtual provider "${outcome.id}".`, 'info')
        return
      }
      await store.saveVirtualProvider(outcome.draft)
      if (outcome.billing !== undefined) {
        for (const [providerId, policy] of Object.entries(outcome.billing)) {
          await store.setProviderBilling(providerId, policy)
          if (policy === undefined) providerBilling.delete(providerId)
          else providerBilling.set(providerId, policy)
        }
      }
      if (outcome.limits !== undefined) {
        for (const [providerId, limit] of Object.entries(outcome.limits)) {
          await store.setProviderLimit(providerId, limit)
          if (limit === undefined) providerLimits.delete(providerId)
          else providerLimits.set(providerId, limit)
        }
      }
      await reconcile(ctx)
      const verb = stored.some(candidate => candidate.id === outcome.draft.id) ? 'Saved' : 'Created'
      ctx.ui.notify(`${verb} virtual provider "${outcome.draft.id}". Select "${outcome.draft.models[0]!.id}" on provider "${outcome.draft.id}" in /model.`, 'info')
    },
  })
}
