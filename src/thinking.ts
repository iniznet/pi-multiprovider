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

// Intersects the thinking support of all reasoning-capable sources. Sources
// with reasoning disabled never reject a thinking parameter (their provider
// omits it), so they neither contribute to nor restrict the intersection.
// The result is advertised as an identity map so pi clamps the session's
// default level onto the best level every backend can actually serve.
export function resolveVirtualThinkingMap(
  sources: readonly ThinkingSource[],
): ThinkingLevelMap | undefined {
  const reasoningSources = sources.filter(source => source.reasoning)
  if (reasoningSources.length === 0) return undefined

  const intersection = ALL_LEVELS.filter(level =>
    reasoningSources.every(source => supportedThinkingLevels(source).has(level)))

  // pi clamps the default level by walking up the canonical order from
  // "medium" (high -> xhigh -> max, then down to low). The operator's order
  // prefers low over max; when only those two are available the advertised
  // map must hide max so the clamp lands on low instead of walking up past
  // it. The backing models still accept max at dispatch time.
  const preferred = new Set(intersection)
  if (
    preferred.has('max')
    && preferred.has('low')
    && !preferred.has('high')
    && !preferred.has('medium')
    && !preferred.has('xhigh')
  ) {
    preferred.delete('max')
  }

  const map: ThinkingLevelMap = {}
  for (const level of ALL_LEVELS) {
    if (preferred.has(level)) map[level] = level
    else if (level !== 'xhigh' && level !== 'max') map[level] = null
    // xhigh/max stay absent when unsupported: pi-ai treats a missing mapping
    // for these as "level does not exist".
  }
  return map
}
