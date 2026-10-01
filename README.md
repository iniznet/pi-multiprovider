<div align="center">

# 🔀 pi-multiprovider

**Multi-account credential pooling and safe same-provider failover for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_One provider ID. One model ID. As many API-key or OAuth accounts as you need._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-multiprovider/main/media/cover.svg" alt="Animated abstract artwork: violet, indigo, cyan, and teal credential streams converge into a glowing scheduler nexus and leave as one luminous current — one stream briefly flares and cools down while the rest carry the load" width="1100">
</p>

[![npm version](https://img.shields.io/npm/v/pi-multiprovider?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-multiprovider)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-multiprovider/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-multiprovider/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![Node 22](https://img.shields.io/badge/node-%E2%89%A522.19-339933?style=for-the-badge&logo=node.js)](package.json)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

---

Pi normally owns **one stored credential per provider**. `pi-multiprovider` adds a second, provider-scoped credential store and lifts the provider's native stream in place. Each request leases an account, resolves that account's auth, and delegates to the original provider without inventing aliases such as `zro-2` or changing the selected model.

If an account fails before visible output, the lift can cool it down and retry another account inside the same logical stream. Once text, thinking, or a tool call is visible, replay stops—duplicate output is worse than a surfaced error.

## Why multiprovider?

| | Capability | What it does |
| :-: | --- | --- |
| 🔐 | **Multiple credentials** | Store API keys and provider-native OAuth credentials per provider. |
| 🪄 | **`/multilogin`** | Reuses Pi's searchable provider selector and login dialog, then opens a searchable settings-style pool manager for drilling into every row inline. |
| 🔀 | **Four pool strategies, two levels** | Round robin, weighted round robin, least in flight, or priority failover—applied to providers and again to models within one. |
| 🔃 | **`/switch-account`** | Session pin to one pooled account for the current model—restored when the session is resumed; pool settings untouched. |
| 🧬 | **Upstream merge** | Optionally treats Pi's normal `/login`, `auth.json`, environment, or ambient credential as another account—editable inline like any stored account. |
| 🩺 | **Health-aware leases** | Tracks in-flight work, failures, cooldowns, session affinity, and retry exclusions. |
| ♻️ | **In-place reauthentication** | Re-run a provider login for an existing account and swap its credential without losing label, weight, priority, or session pins. |
| 🛡️ | **Stream-safe failover** | Suppresses a rejected attempt's start/error events and retries only before user-visible output. |
| 🧱 | **Error tolerance before switching** | Absorbs up to 3 pre-output errors on the same account before failing over, so one blip never pays a cold-cache switch. |
| 🪪 | **Stable identity** | Provider ID, model ID, model picker entries, routing, and session history remain unchanged. |

## Install

Requires Node.js 22.19+ and Pi 0.84.3+.

```bash
pi install npm:pi-multiprovider
```

The npm package registers the extension automatically. Install the provider extension you want to pool as usual; for example:

```bash
pi install npm:pi-zro-provider
pi install npm:pi-multiprovider
```

<details>
<summary>Other install methods</summary>

From the new GitHub repository:

```bash
pi install git:github.com/monotykamary/pi-multiprovider
```

From a local checkout:

```bash
bun install
bun run build
pi install /absolute/path/to/pi-multiprovider
```

For one development run:

```bash
pi -e /absolute/path/to/provider-extension \
   -e /absolute/path/to/pi-multiprovider/extensions/multiprovider.ts
```

</details>

## Quick start

Start Pi after installing both extensions, then run:

```text
/multilogin
```

The flow:

1. Searches providers and authentication methods exactly where Pi's `/login` UI does.
2. Opens the pool manager, a settings view mirroring Pi's `/settings`: fuzzy search, inline value cycling, and drill-in submenus.
3. The **Add account** row asks for a non-secret label and runs the provider's own login implementation—including pasting an API key for providers without an interactive flow—then returns to the manager.
4. Every other row edits live settings: pool strategy and session affinity, an **Accounts** section grouping every pooled credential—**Pi default (upstream)** plus stored accounts—with per-account weight (traffic share), priority (failover order), and max concurrent requests (a soft cap on simultaneous work), and scheduler cooldowns.

Add as many accounts as you need from the same manager. Remove credentials from an account's submenu or with `/multilogout`; Pi's regular `/logout` and `auth.json` remain independent. **Reauthenticate** in a stored account's submenu re-runs the provider's own login flow and replaces that account's credential in place — label, weight, priority, and session pins stay, and the account's cooldown clears. Use it when a provider revokes or invalidates a refresh token (for example `refresh_token_invalidated`) instead of removing and re-adding the account.

### Commands

| Command | Purpose |
| --- | --- |
| `/multilogin [provider]` | Open the pool manager: strategy, affinity, upstream, account, and scheduler settings, plus adding or removing accounts. |
| `/multilogout [provider]` | Remove an account saved by `/multilogin`. |
| `/vprovider [id]` | Create and edit virtual providers that map one model across multiple provider models. |
| `/accounts` | Inspect pool policy, account status, in-flight leases, failures, and cooldowns. |
| `/switch-account [label / auto / pick]` | Pin this session to one pooled account (or one virtual backend) of the current model, return to automatic selection, or run the pool's strategy right now and keep its answer. Arguments autocomplete, listing the sessions already attached to each target. The choice is restored the next time the session is resumed. |
| `/serving [on\|off]` | Show or hide the line above the editor naming which backing provider (and account) is serving the current virtual model; with no argument it reports the last dispatch. |

## Pool strategies

| Strategy | Selection behavior | Good for |
| --- | --- | --- |
| **Round robin** | Starts at the first healthy account in pool order (the **main account**) and spills over to later accounts only while earlier ones are unavailable. Unbiased pools rotate through healthy accounts in pool order from a random starting account, and differing weights shape traffic shares. | A primary subscription with backup accounts. |
| **Weighted round robin** | Uses smooth weighted scheduling. | Accounts with different quotas or spend limits. |
| **Least in flight** | Selects the healthy account with the least active work. | Concurrent agents and uneven request duration. |
| **Priority failover** | Uses the lowest-priority number until it becomes unhealthy. | Primary/backup credentials. |

Any of the four can also run as the **provider strategy** of a virtual pool, deciding the backing provider first while the pool's own strategy picks the model inside it; see [Two-level selection](#two-level-selection-provider-strategy-and-model-strategy).

First-account bias keeps every new session on the account listed first in the pool—**Pi default (upstream)** when included, otherwise the first stored account—so you stop seeing sessions start on a backup account while the main one has plenty of usage. Integrations that want even request rotation register with `selectionBias: 'none'`, which restores the classic rotate-through-healthy-accounts behavior: accounts rotate in pool order (the order they are configured, never re-sorted by id), the rotation starts at a random account so restarts do not favor the same one, and differing per-account weights share traffic smoothly instead of being ignored.

Session affinity can pin a healthy account to the current Pi session. Explicit retry exclusions always win, so a rejected account is not selected twice for the same logical request. Switch strategies, affinity, and per-account weight and priority at any time inside `/multilogin`. `/switch-account` sets the pinned account explicitly for one session without touching these settings. Pi Fabric participant agents inherit that pin through `PI_MULTIPROVIDER_SESSION_PINS` and rebind it to the child session, so spawned workers keep the operator's chosen account.

**Affinity is scoped to the requesting session, not to the process.** Pi core carries each request's session id on the stream options, so a nested agent that runs its own session — a Fabric participant, a workflow worker, an in-process sub-agent — gets its own sticky account instead of inheriting the host session's pin, and keeps it across its own turns. Precedence: an integration's own `affinityKey` (a deliberate routing decision) wins, then the caller-declared session, then the host session id. A request with no session identity at all selects purely by pool policy rather than sharing one bucket with every other identity-less caller.

### Error tolerance and failover compaction

A rejected account is not abandoned on the first error. Each stream absorbs up to `errorsBeforeSwitch` (default **3**, configurable in the `/multilogin` Scheduler panel) pre-output errors on the same account—separated by a short pause—before releasing the lease, applying the failure cooldown, and moving to the next account. Errors after output has started and non-retryable failures surface immediately, exactly as before.

When [pi-fabric](https://github.com/monotykamary/pi-fabric) is installed, failing over to a different account first compacts the session with fabric's deterministic, LLM-free compaction engine. The failing request surfaces its error, the session compacts while the retry backoff runs, and the retry lands on the next account with a small context instead of a huge cold prefill. This is the default behavior; without fabric installed, streams rotate accounts inline as before.

### Shared session attachments

Scheduler affinity lives in memory, per process — so a picker in one terminal tab cannot see what the other three tabs are running, and every row reads `no sessions` even while they stream. To fix that, each dispatch mirrors its pin into `multiprovider-auth.json` under `sessions`, and every list merges the local table with those mirrored rows:

- **What is stored**: pool id, session id, account id, account label, whether the pin was explicit, and a timestamp. No credential material of any kind.
- **Write pressure**: an unchanged pin is re-mirrored at most every 5 minutes, not once per turn. Explicit switches and clears write immediately, because those are decisions other processes should see at once.
- **Liveness**: pi has no cross-process "is that tab still open" signal, so freshness is the proxy — a row nobody refreshed for 30 minutes is treated as closed and dropped on the next write. A session that wakes up re-registers on its next request.
- **Growth**: bounded per pool (newest 64 sessions), so a busy machine cannot grow the file without limit.
- **Authority**: the local table always wins for its own session. A mirrored row can predate a switch this process just made, so merging never lets stale disk data override live state.
- **Where it shows**: the `/switch-account` argument list and menu, and every backend row in `/vprovider`. A store read failure degrades those to this-process rows rather than blanking them.

## Virtual providers

A virtual provider maps **one model to multiple provider models**. Sessions are spread across the backing providers with unbiased round robin—no first-provider favoritism—while session affinity pins each session to one backend, so prompt caches stay warm between requests and every subscription sees roughly its share of sessions.

`/vprovider` exposes **Session affinity** per pool. Leave it on for interactive use; set it to `off (rotate)` when a fan-out host's nested agents share one session identity and you would rather spread them across backends than concentrate a burst on one credential. Explicit `/switch-account` pins take precedence either way.

Each backend row also names who is on it — `this session`, `2 others`, or `no sessions` — counted across every open pi process, so you can see a pool collapsing onto one credential before you send anything.

### Two-level selection: provider strategy and model strategy

A backing provider limits concurrency **per model**, and one virtual pool routinely holds several models on the same provider. A single strategy over a flat backend list cannot express "spread across providers, then pick a model with headroom", so `/vprovider` exposes two:

| Row | Decides | When off |
| --- | --- | --- |
| **Provider strategy** | which backing provider serves the request | `off (one flat pass)` — one strategy chooses among all backends, exactly as pools behaved before |
| **Model strategy** | which model on that provider serves it | always active; when the provider strategy is off it governs the whole pool (`· all backends`) |

Both accept the same four strategies. A provider is scored as the **sum** of its backends' weights, and its in-flight count is the sum across its backends — so a provider holding three backends takes three times the share of an equal-weight single backend under weighted round robin.

### Ordering: which provider runs first

Choosing **Priority** as the provider strategy means *primary, then backup, then last resort*. What decides the order is **not** the backend list — it is the provider's rank:

```
rank = providerPriority[provider]      ← set by the ordering page
     ?? min(priority of its backends)  ← derived, the fallback
```

The derived rule has a sharp edge worth knowing: every backend defaults to priority `0`, so a fresh pool gives **every provider rank 0**. They are all tied, all primary, and priority falls through to the tie-break — least in-flight, then least recently used. That is load sharing, not failover, and it looks like "the strategy isn't working" when it is simply unordered. `providers (priority order)` exists to remove that ambiguity:

```
Providers (priority order)
  1. opencode-go · rank 0 · 1 model
  2. commandcode · rank 1 · 4 models
  3. hypercharm · rank 2 · 2 models
```

Enter a provider to **Move up**, **Move down**, **Move to front**, or **Set rank**. The first move materializes every provider's rank as a sequential number, so an ambiguous derived order becomes an explicit one you can read off the list. Ties you create deliberately (two providers at rank `0`) still load-share instead of secretly preferring whichever was listed first.

**Clear explicit ranks (rank by backends again)** removes `providerPriority` entirely and returns the pool to deriving each provider's rank from its best backend — the row only appears while explicit ranks exist, and the page header always says which of the two modes you are in.

A tier hands over when it genuinely cannot serve, and comes back on its own:

| Tier becomes unavailable when | How long |
| --- | --- |
| 429 / rate limit | `rateLimitCooldownMs` (60s default) |
| 402 / quota / out of credit | `quotaCooldownMs`, or the provider's billing reset when marked, and every model on it is skipped **before** any HTTP attempt |
| 401 / 403 / revoked token | `authCooldownMs` (5m) |
| 5xx / timeout / network | exponential backoff from `transientBaseCooldownMs`, capped at `maxCooldownMs` |
| you disable its backends | until you re-enable them |

Recovering the first tier returns traffic to it automatically — there is nothing to un-pin.

**Ordering models inside a provider** works the same way, on the existing backend page: **Move up / Move down / Move to front** rewrite backend priorities (shown as `Order position: 2 of 7`, and as `· p1` on the row), which is what **Model strategy: priority** reads. Ranking the whole list keeps each provider's internal order intact, because models are only compared inside the provider already chosen. When the model strategy is not `priority`, those numbers do not decide anything — least-inflight, round robin and weighted round robin ignore them.

**Concurrency caps.** Each backend takes a `Max concurrent requests` value (`0` or blank clears it). Selection prefers backends below their cap, and a provider drops out of stage one entirely only when *every* one of its models is at the cap. A backend with no cap shows no load column, because a bare count has nothing to be measured against:

```
hypercharm · glm-5.3-flash · enabled · w1 · this session · 2/2 in flight
hypercharm · glm-5.3-flash-air · enabled · w1 · no sessions · 0/1 in flight
opencode-go · glm-5.3-flash · enabled · w1 · no sessions
```

### Provider-wide ceilings

Some providers limit concurrency across **every** model on the account, not per model. That limit cannot be expressed by capping each backend: five models capped at two still allow ten simultaneous requests where the provider permits three. So the ceiling is marked on the provider, in `/vprovider`:

```
Billing (hypercharm): daily · resets 00:00
Limit (hypercharm): 3 concurrent per process · 2/3 in flight
Limit (opencode-go): uncapped
```

It lives in `providerQuota` next to the billing cycle in `multiprovider-auth.json`, because it is a fact about the provider that every pool using it must respect — set it once and it bounds that provider inside each virtual pool and inside its account pool.

The ceiling filters **eligibility**, exactly like a per-account cap, so it applies whether the pool runs two-level selection or one flat pass. Group load counts every eligible member on that provider, including models already at their own cap, because a model that cannot take more work still holds the slots it has. The two limits compose and the stricter one bites:

| request | hypercharm in flight | served by |
| --- | --- | --- |
| 1 | 0/3 | `hypercharm/flash` (0/2) |
| 2 | 1/3 | `hypercharm/air` (0/1) |
| 3 | 2/3 | `hypercharm/flash` (1/2) |
| 4 | **3/3** | `opencode-go/…` — every hypercharm model is below *its own* cap, yet the provider is full |

Like the per-model cap, a ceiling is **advisory**: when every provider is at its ceiling, selection serves the least loaded backend rather than failing the turn.

**Ceilings are per pi process.** The in-flight counter lives in one process's scheduler, so five tabs on the same pool each hold their own budget and the provider can see up to five times the ceiling. That is the right shape for a fan-out host — Fabric participants and workflow workers share one process, so one counter is accurate — and an approximation across separate terminals. True cross-process enforcement would need a shared reservation registry written on every acquire and release, with TTL sweep to reclaim slots from a process killed mid-stream; it costs a disk write per request and under-uses the provider during the reclaim window, so it is deliberately not built.

- The cap is **advisory, never a refusal**. When every eligible backend is at its cap, the scheduler serves the least loaded one instead of failing: a fan-out of twenty agents against a cap of two degrades gracefully rather than dead-ending. Account pools' `Max concurrent` works the same way, including on the **Pi default** credential.
- **An explicit pin outranks a cap.** `/switch-account` exists to override the scheduler, so a session pinned to a backend at its cap stays there; caps only steer *automatic* placement.
- Model rotation state is tracked **per provider** once a provider strategy is set, so a provider does not get paired with the same model on every visit.
- Session cache affinity is unchanged: the pin records the whole `(provider, model)` backend, and both stages only run when a session has no pin.

Create one with `/vprovider`:

1. Choose **Create new virtual provider**, then set the provider id and virtual model id.
2. Add one or more **backing provider models**—pick any registered provider and one of its models from a fixed-height, type-to-filter list. Toggle, reweight, set a concurrency cap, or remove backends at any time.
3. **Save and apply**. The virtual model appears in `/model` under the virtual provider's id.

Behavior details:

- Each request resolves auth at the backing provider layer: the provider's own ambient credential (Pi `/login`, auth.json, environment) or, when the backing provider has a multiprovider pool, its pooled accounts with their own failover.
- A failing backend fails over to the next one before any output streams; the failed backend cools down under the same scheduler policies as account pools.
- `/switch-account` works on virtual models too: pin the session to one backing provider model, or return to automatic rotation.
- Virtual provider configs are stored (credential-free) in `multiprovider-auth.json` next to the account pools.
- Mixing backends from different model families is allowed, but the virtual model advertises the first healthy backend's context window and pricing, and prompt caches never transfer between providers.
- Virtual models capture each backing model's metadata (reasoning support, thinking-level map, context window, pricing) when you pick it, so `/thinking` and per-model thinking memory (pi-model-sort) work across restarts and session resume — even before backing providers register. Stored configs are healed automatically on the next session start.
- **Thinking levels are the union across backends, and the level adapts to the backend — never the reverse.** The virtual model advertises every level at least one enabled backend can serve, so a mixed pool (say a `low/high/max` model beside a `low/medium/xhigh` one) still lets you select `high`. Selection then stays across the **whole** pool: whichever backend the strategy picks is sent the nearest level it can serve (`high` becomes `medium` on a medium-only backend, ties resolving downward so a pool never silently spends more on reasoning than you asked for), and the serving line shows the substitution as `· high→medium`. Backends are never filtered out for thinking support, so a level can never silently concentrate every session on one provider. Set the level with `/thinking`, then Ctrl+S in pi's dialog to store it as the default.
- **Quota failures block the provider, not just the account.** Mark each backing provider with its billing cycle in `/vprovider` (`daily`, `weekly`, `monthly`, or a rolling `5h` window, with a configurable local reset hour for the calendar kinds). When a backend returns `402`/`429`/out-of-credit, every virtual backend on that provider is skipped — with zero HTTP spent — until the cycle resets; the marking persists in `multiprovider-auth.json`, so the block survives a restart. Unmarked providers fall back to the scheduler's quota cooldown.
- **Providers that publish usage windows are probed directly.** For backends with a usage endpoint (opencode's `GET {baseUrl}/usage` today), each pooled account is polled on a slow cadence and after a quota failure: exhausted accounts are held out of selection until the API-reported reset, sibling accounts keep serving, and `/accounts` plus `/vprovider` show the remaining budget (`5h: 63% · 7d: 41% · 30d: 12%`).
- **Metadata rejections are learned per level, not retried.** An upstream that rejects a model's declared parameters (a `400 invalid_request` such as `reasoning_effort is not allowed`) flags that `(provider, model, level)` triple for the rest of the process, surfaces the error once, and skips the pair **at that level**. Ask for a different level later and the same backend serves again; a rejection received while no thinking parameter was sent marks the pair for every level. A level the backend never advertised is not a rejection at all — it is degraded before the request, so nothing gets flagged. Fix the underlying metadata (for example `supportsReasoningEffort: false` in a provider patch) to have the pair skipped before the request instead of learning it from one 400.
- The line `↳ serving <provider> · <model> · <account>` above the editor names which backend a virtual model actually dispatched to, refreshed at dispatch time and on failover, and suffixed `· <asked>→<sent>` when your thinking level had to be degraded; `/serving off` hides it.

## Switching accounts for one session

`/switch-account` lists every account pooled under the current model's provider—including **Pi default (upstream)** while its credential is configured—and pins the choice to the current Pi session:

- The pin is session-scoped. Pool strategy, affinity, weights, and priorities stay untouched. Every switch is recorded in the session file as a custom entry that is never sent to the model, so resuming the session restores the last switched account instead of falling back to the pool strategy.
- New requests from this session use the pinned account, even while the pool's session affinity is off.
- If the pinned account cools down, another account serves temporarily and the session returns to it once it recovers. Removing or disabling the account drops the pin for the rest of the session.
- **Automatic**—or `/switch-account auto`—clears the pin so the pool strategy selects again; the cleared state is recorded too, so a resumed session stays automatic.
- `/switch-account work` switches directly when the label matches exactly or by unique prefix.
- **Pick now** — `/switch-account pick` — runs the pool's configured strategy immediately and pins the result, so you can see where a session will land before spending a request on it. The probe records no health against the account. In a non-interactive session (headless or RPC) there is no menu to open, so the command picks by strategy when given no argument at all.
- **Autocompletion**: start `/switch-account ` and pi lists `auto`, `pick`, then every account with its state and who is on it — `current`, `this session + 2 others`, or `no sessions`. That is how you find an idle credential in a fan-out instead of stacking every agent onto one. The counts include sessions in **other pi processes**; see [Shared session attachments](#shared-session-attachments).
- If the pinned account was removed or disabled before the session is resumed, the session warns once and falls back to automatic selection.

In-flight requests keep their leased account; only new requests observe the switch. Sibling extensions can follow switches—and the account a resumed session restores—through the [`pi-multiprovider:service` event](#session-account-service-event).

## How auth merging works

Pi still owns its one normal provider credential. Multiprovider owns additional credentials:

```text
~/.pi/agent/auth.json                    Pi /login and normal credential
~/.pi/agent/multiprovider-auth.json      extra pooled credentials
```

`PI_CODING_AGENT_DIR` relocates both files in the usual way. The multiprovider file is:

- created with mode `0600`
- written through same-directory atomic renames
- protected by a cross-process lock with stale-lock recovery
- versioned for future migrations
- never included in `/accounts` snapshots or logs

API-key credentials use the provider's native `resolve()` method, including provider-scoped environment values. OAuth credentials use the provider's native `login()`, `refresh()`, and `toAuth()` methods; refresh runs under the account-store lock with Pi's five-minute validity window.

When **Pi default** is enabled, the lifted auth method first lets Pi resolve its normal credential. Multiprovider marks only the names—not values—of credential-specific headers and environment fields. If a stored account is selected, stale upstream auth fields and credential-specific base URLs are removed before transport.

Inside `/multilogin` the **Pi default** credential appears in the pool's account list like any stored account: relabel it, raise or lower its weight (default 1) and priority (default 0), or disable it so only multilogin accounts run. When no pool exists yet but `/login` already has a credential configured, it is listed as pending so it can be preconfigured before the first stored account. The credential value itself stays Pi-owned—rotate or replace it through `/login`. Pool, account, upstream, and scheduler settings persist alongside the credentials in `multiprovider-auth.json`. The manager's **Scheduler** section overrides the global failure cooldowns live: rate limit (60s), quota (15m), auth (5m), transient base (1s, doubling per consecutive failure), and the 60m cap.

## Failover semantics

An account can be retried when all of these are true:

1. The provider failed before text, thinking, or tool-call output became visible.
2. The failure is account-local or transient.
3. Another enabled account is healthy and has not been attempted.

Default retry classes include:

- HTTP `401`/`403`, invalid keys, tokens, grants, or expired credentials
- HTTP `402`, quota exhaustion, or out-of-credit messages
- HTTP `429`, rate limits, overload, or too-many-requests responses
- HTTP `408`, `425`, and `5xx` transient failures

The lift sets provider-local retries to zero by default so there is one retry owner. Provider integrations can override classification and cooldown duration.

### Real ZRO proof

The implementation was exercised against the actual sibling `pi-zro-provider` and two independently stored LocalTerm credentials. Secret values were passed only through process environment into isolated mode-`0600` test stores and were never printed.

| Probe | Result |
| --- | --- |
| First stored ZRO API key, no `ZRO_API_KEY` environment fallback | `ZRO_FIRST_OK` |
| Second stored ZRO API key, no `ZRO_API_KEY` environment fallback | `ZRO_SECOND_OK` |
| Priority-1 synthetic invalid key → priority-2 valid key, same `zro/deepseek-v4-flash-0731` stream | `ZRO_FAILOVER_OK` |

The package also has direct Pi runtime probes and 31 deterministic tests covering scheduling, session account pinning, the service announcement, stream integrity, cancellation, secure storage, concurrent mutation, OAuth refresh locking, upstream auth scrubbing, upstream preference persistence, scheduler settings, pool-only availability, and simulated API-key/OAuth login flows.

## Provider integration API

The built-in managed store works with native providers and legacy `pi.registerProvider()` configurations composed by Pi. Providers with an existing account inventory can register their own opaque references instead:

```ts
import { registerMultiProvider } from "pi-multiprovider";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function providerExtension(pi: ExtensionAPI) {
  registerMultiProvider(pi, {
    id: "example",
    label: "Example",
    accounts: async () => [
      {
        id: "work",
        label: "Work",
        authKind: "api-key",
        credentialRef: "opaque:work",
        weight: 2,
        priority: 1,
      },
      {
        id: "backup",
        label: "Backup",
        authKind: "oauth",
        credentialRef: "opaque:backup",
        priority: 2,
      },
    ],
    async resolveAuth(account, signal) {
      return resolveProviderOwnedCredential(account.credentialRef, signal);
    },
  });
}
```

Credential references are intentionally opaque. Account inventory, refresh, billing, quota, and provider-specific metadata remain provider-owned. Re-announce after a provider re-registers dynamically; the bundled extension also reconciles its lift before every agent run.

### Session account service event

The bundled extension announces a small in-process service on `pi-multiprovider:service` (emitted at load and on session start) so sibling extensions can follow the session's active pooled account—for example, to refresh account-scoped subscription usage views after `/switch-account` or a resume:

```ts
import {
  MULTIPROVIDER_SERVICE_EVENT,
  type MultiProviderServiceAnnouncement,
} from "pi-multiprovider"

pi.events.on(MULTIPROVIDER_SERVICE_EVENT, value => {
  // Duck-check value.getActiveAccount / resolveActiveAccountAuth /
  // onActiveAccountChanged, or cast to MultiProviderServiceAnnouncement.
})
```

- `getActiveAccount(providerId, ctx)` — the session's effective account: the explicit `/switch-account` pin, else the scheduler's last selection while pool affinity is on. `undefined` means selection is automatic or upstream, and callers should fall back to their own credential resolution.
- `resolveActiveAccountAuth(providerId, ctx, signal?)` — resolves (refreshing OAuth under the account-store lock when needed) the active stored account's credential as `{ accessToken, label, source? }`. Returns `undefined` for the upstream account or when nothing is active, so consumers keep their existing fallback chain.
- `onActiveAccountChanged(providerId, callback)` — fires after `/switch-account` pins or clears, and when a session start replays a recorded pin (resume, fork, or session switch). The event carries the triggering `ctx` and the new active account—`undefined` when the replayed decision returned the session to automatic selection—so account-scoped widgets repaint with the restored account instead of waiting for their next poll. Listeners attached after a replay can rely on their own session start, which observes the already-restored pin.

Credential values are never broadcast in the event payload itself; only extensions that invoke the resolver receive them, and the private `multiprovider-auth.json` store is never read directly by consumers.

For direct composition, the public package exports `MultiProviderService`, `liftProvider`, `MultiAuthStore`, `createManagedIntegration`, `mergeProviderAuth`, and all scheduler/integration types.

## Safety boundaries

- **No replay after output.** A failure after any content event is surfaced unchanged.
- **No secret snapshots.** Public account state contains labels and health only, never credential references or credential values.
- **Case-insensitive header replacement.** Selected auth replaces matching headers and can remove obsolete auth fields.
- **Lease lifetime equals stream lifetime.** Success, failure, and cancellation release capacity exactly once.
- **Provider re-registration is expected.** The extension re-lifts current provider objects before agent execution, covering dynamic model refreshes used by provider packages.
- **Health is in memory.** Cooldowns and implicit session affinity reset when Pi reloads or replaces the extension runtime; credentials, pool settings, and the `/switch-account` decisions recorded inside a session persist with it.

Current limits:

- Deferred fetch/cancel operations are not lifted yet; `stream` and `streamSimple` are the supported failover paths.
- A broken or revoked OAuth credential in Pi's primary `auth.json` can fail during Pi's pre-stream refresh before account selection. Repair that one through Pi's own `/login` (`/logout` first when the old credential blocks the flow) — multiprovider never writes it. Pooled credentials refresh independently and can be repaired in place with **Reauthenticate** in the `/multilogin` account submenu.
- If both a stored pool and a provider-owned integration register for one ID, the stored pool wins and Pi displays a warning.
- Provider-owned integrations with a custom `affinityKey` are invoked with a minimal context by `/switch-account`; keys that depend on request message history cannot be reproduced there and fall back to the Pi session id.
- Pi **workflow subagents** (pi-dynamic-workflows) load no host extensions, so pooled and virtual providers are not registered inside their session: point those agents at a concrete `provider/model` instead of a virtual model id. In-process Fabric calls and Fabric participant processes do go through multiprovider's scheduler.

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```

The full release gate is:

```bash
bun run check
npm pack --dry-run
```

See [SECURITY.md](SECURITY.md) for the local credential threat model and private vulnerability reporting.

## Acknowledgments

- Inspired by [hjanuschka/pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass), while keeping one provider identity and moving retries down to the stream boundary.
- Scheduler and credential-ownership semantics mirror the lift used by [`dsh-multiprovider`](../dsh-multiprovider) during local development.
- Built on Pi's native `Provider`, auth interaction, and TUI component APIs.

## License

MIT
