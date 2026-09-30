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

// Unions the thinking support of all reasoning-capable sources: a level is
// advertised when at least one backend can serve it. Sources with reasoning
// disabled never reject a thinking parameter (their provider omits it), so
// they neither contribute to nor restrict the map.
//
// Union (not intersection) because virtualStream guards every attempt: a
// backend whose live model cannot serve the requested level is skipped
// pre-flight without spending an HTTP call. Intersecting instead would let a
// single weak backend cap the whole pool — a mixed glm (low/high/max) +
// Qwen (low/medium/xhigh) pool would advertise only 'low' and the operator
// could never select 'high' at all.
//
// The result is an identity map, so pi clamps the session's default level
// against exactly what the pool can serve; selecting a level only some
// backends support narrows which backends serve that session.
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
