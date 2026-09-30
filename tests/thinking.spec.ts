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
  it('intersects the maps of all reasoning backends', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: glmFlashMap },
      { reasoning: true, thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' } },
    ])
    // Intersection: low + high; medium/minimal are null on one source, max is
    // not explicitly mapped on the second.
    expect(map).toEqual({ off: null, minimal: null, low: 'low', medium: null, high: 'high' })
  })

  it('keeps max when only max and low survive the intersection (deepest wins)', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: null, max: 'max' } },
      { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: null, max: 'max' } },
    ])
    // pi clamps its default up the canonical order (medium -> high -> xhigh ->
    // The operator prefers the deepest reasoning possible, so max stays
    // advertised and pi's clamp walks up to it when high is unavailable.
    expect(map).toEqual({ off: null, minimal: null, low: 'low', medium: null, high: null, max: 'max' })
  })

  it('keeps max when it is the only surviving level', () => {
    const map = resolveVirtualThinkingMap([
      { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, max: 'max' } },
    ])
    expect(map).toEqual({ off: null, minimal: null, low: null, medium: null, high: null, max: 'max' })
  })

  it('ignores non-reasoning backends when intersecting', () => {
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
