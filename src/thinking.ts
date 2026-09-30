import type { Model, Api } from '@earendil-works/pi-ai'

// Thinking-level support of a pi model or a captured virtual template. The
// virtual model's advertised map only controls which levels pi offers and
// clamps to; the wire-level effort value is always re-mapped by the backing
// model's own thinkingLevelMap inside its provider, so the virtual map can
// safely use identity values.
export type ThinkingLevelMap = NonNullable<Model<Api>['thinkingLevelMap']>
export type ModelThinkingLevel = Extract<keyof ThinkingLevelMap, string>

export interface ThinkingSource {
  reasoning: boolean
  // '| undefined' so partial metadata snapshots (captured templates with the
  // property present but unset) remain assignable under exactOptionalPropertyTypes.
  thinkingLevelMap?: ThinkingLevelMap | undefined
}

const ALL_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

// Operator's preference order for the auto-selected default level.
export const VIRTUAL_DEFAULT_LEVEL_ORDER: readonly ModelThinkingLevel[] = [
  'high',
  'medium',
  'xhigh',
  'low',
  'max',
]

// Mirrors pi-ai's getSupportedThinkingLevels rules: a level is unsupported
// when explicitly mapped to null, and xhigh/max exist only when explicitly
// mapped. Non-reasoning models support no thinking level at all.
export function supportedThinkingLevels(source: ThinkingSource): Set<ModelThinkingLevel> {
  const supported = new Set<ModelThinkingLevel>()
  if (!source.reasoning) return supported
  for (const level of ALL_LEVELS) {
    const mapped = source.thinkingLevelMap?.[level]
    if (mapped === null) continue
    if ((level === 'xhigh' || level === 'max') && mapped === undefined) continue
    supported.add(level)
  }
  return supported
}

// Canonical rank order, used to measure how far a supported level sits from
// the one a session asked for.
const LEVEL_RANK = new Map<ModelThinkingLevel, number>(
  ALL_LEVELS.map((level, index) => [level, index]),
)

// The level to actually send to a backend when the session asked for
// `requested`: the nearest one that backend supports, measured on pi's
// canonical order. Ties resolve downward so a pool never silently spends more
// on reasoning than the operator asked for.
//
// Thinking level deliberately does not filter which backend serves a request:
// the pool's strategy picks any backend and the level adapts to it. Returns
// undefined when the source can serve no thinking level at all (a non-reasoning
// model, or one whose map nulls every level) — the caller must then omit the
// thinking parameter rather than send an effort the model would reject.
export function nearestThinkingLevel(
  source: ThinkingSource,
  requested: ModelThinkingLevel,
): ModelThinkingLevel | undefined {
  const supported = supportedThinkingLevels(source)
  if (supported.size === 0) return undefined
  if (supported.has(requested)) return requested
  const target = LEVEL_RANK.get(requested) ?? 0
  let best: ModelThinkingLevel | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  // ALL_LEVELS is ascending, so a strict comparison keeps the lowest level when
  // two are equally close to what was asked.
  for (const level of ALL_LEVELS) {
    if (!supported.has(level)) continue
    const distance = Math.abs((LEVEL_RANK.get(level) ?? 0) - target)
    if (distance < bestDistance) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

// Unions the thinking support of all reasoning-capable sources: a level is
// advertised when at least one backend can serve it. Sources with reasoning
// disabled never reject a thinking parameter (their provider omits it), so
// they neither contribute to nor restrict the map.
//
// Union (not intersection) because selection must stay across the whole pool:
// intersecting would let a single weak backend cap everything — a mixed glm
// (low/high/max) + Qwen (low/medium/xhigh) pool would advertise only 'low' and
// the operator could never select 'high' at all. Instead virtualStream sends
// every backend the strategy picks and degrades that request's level to the
// nearest one the backend serves (see nearestThinkingLevel).
//
// The result is an identity map, so pi offers exactly the levels some backend
// can serve; a request at a level the picked backend lacks is served at the
// closest one instead of failing over.
export function resolveVirtualThinkingMap(
  sources: readonly ThinkingSource[],
): ThinkingLevelMap | undefined {
  const reasoningSources = sources.filter(source => source.reasoning)
  if (reasoningSources.length === 0) return undefined

  const union = new Set<ModelThinkingLevel>()
  for (const source of reasoningSources) {
    for (const level of supportedThinkingLevels(source)) union.add(level)
  }

  // pi clamps an unsupported requested level by walking UP the canonical
  // order (high -> xhigh -> max) before walking down, so every surviving
  // level stays selectable per session and the deepest one the pool can
  // serve is always reachable.
  const preferred = union

  const map: ThinkingLevelMap = {}
  for (const level of ALL_LEVELS) {
    if (preferred.has(level)) map[level] = level
    else if (level !== 'xhigh' && level !== 'max') map[level] = null
    // xhigh/max stay absent when unsupported: pi-ai treats a missing mapping
    // for these as "level does not exist".
  }
  return map
}
