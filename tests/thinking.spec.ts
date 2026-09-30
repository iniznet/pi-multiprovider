import { describe, expect, it } from 'vitest'
import { resolveVirtualThinkingMap, supportedThinkingLevels } from '../src/index.ts'

const glmFlashMap = {
  off: null,
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: null,
  max: 'max',
}

describe('supportedThinkingLevels', () => {
  it('returns nothing for non-reasoning models', () => {
    expect(supportedThinkingLevels({ reasoning: false })).toEqual(new Set())
  })

  it('excludes explicitly null levels and requires explicit xhigh/max', () => {
    const supported = supportedThinkingLevels({ reasoning: true, thinkingLevelMap: glmFlashMap })
    expect(supported).toEqual(new Set(['low', 'high', 'max']))
  })

  it('includes unmapped basic levels and off by default', () => {
    const supported = supportedThinkingLevels({ reasoning: true })
    expect(supported).toEqual(new Set(['off', 'minimal', 'low', 'medium', 'high']))
  })
})

describe('resolveVirtualThinkingMap', () => {
  it('unions the maps of all reasoning backends', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: glmFlashMap },
      { reasoning: true, thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' } },
    ])
    // Union: 'high' survives even though only one source maps it, and 'max'
    // stays reachable because some backend serves it. 'minimal' is nulled on
    // one source but unmapped on the other (basics default to supported), so
    // it is advertised; 'off' is nulled on both and 'xhigh' is never mapped.
    expect(map).toEqual({
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max',
    })
  })

  it('advertises a level one backend caps out below (mixed pool)', () => {
    // The real-world shape: a glm backend (low/high/max) pooled with a Qwen
    // backend (off/low/medium/xhigh, high explicitly null). Intersecting would
    // advertise only 'low'; the union keeps 'high' selectable and the
    // per-attempt capability guard routes it to the backends that serve it.
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: glmFlashMap },
      { reasoning: true, thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null } },
    ])
    expect(map).toMatchObject({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
    expect(map!.minimal).toBeNull()
  })

  it('keeps max when only max and low are supported across the pool', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: null, max: 'max' } },
      { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: null, max: 'max' } },
    ])
    // The operator prefers the deepest reasoning possible: max stays
    // advertised, and pi's clamp walks up the canonical order (medium -> high
    // -> xhigh -> max) to reach it when lower levels are unavailable.
    expect(map).toEqual({ off: null, minimal: null, low: 'low', medium: null, high: null, max: 'max' })
  })

  it('keeps max when it is the only surviving level', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, max: 'max' } },
    ])
    expect(map).toEqual({ off: null, minimal: null, low: null, medium: null, high: null, max: 'max' })
  })

  it('ignores non-reasoning backends when unioning', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: glmFlashMap },
      { reasoning: false },
    ])
    expect(map).toEqual({ off: null, minimal: null, low: 'low', medium: null, high: 'high', max: 'max' })
  })

  it('returns undefined when no backend reasons', () => {
    expect(resolveVirtualThinkingMap([{ reasoning: false }])).toBeUndefined()
    expect(resolveVirtualThinkingMap([])).toBeUndefined()
  })

  it('unmapped basic levels stay supported; nulled basics are dropped', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: { low: null, high: null, off: null } },
    ])
    expect(map).toEqual({ off: null, minimal: 'minimal', low: null, medium: 'medium', high: null })
  })
})
