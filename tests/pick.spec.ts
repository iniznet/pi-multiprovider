import { describe, expect, it } from 'vitest'
import { pickSuggestions, sessionsOn, type AffinityEntry } from '../src/index.ts'

const pins = (entries: [string, string][]): AffinityEntry[] =>
  entries.map(([key, accountId]) => ({ key, accountId, explicit: false }))

describe('pick suggestions', () => {
  it('describes who is attached to an account from the caller point of view', () => {
    expect(sessionsOn(pins([['s1', 'a'], ['s2', 'a']]), 'a', 'current')).toBe('2 others')
    expect(sessionsOn(pins([['current', 'a']]), 'a', 'current')).toBe('this session')
    expect(sessionsOn(pins([['current', 'a'], ['s2', 'a']]), 'a', 'current'))
      .toBe('this session + 1 other')
    expect(sessionsOn(pins([['s2', 'a']]), 'b', 'current')).toBeUndefined()
  })

  it('lists the automatic modes first, then one row per candidate', () => {
    const items = pickSuggestions({
      candidates: [
        { id: 'a', label: 'HyperCharm · glm-5.3-flash', detail: 'custom' },
        { id: 'b', label: 'OpenCode · glm-5.3-flash', detail: 'custom' },
      ],
      pins: pins([['current', 'a'], ['s2', 'a']]),
      currentKey: 'current',
      currentId: 'a',
      policy: 'round-robin',
    })
    expect(items.map(item => item.label))
      .toEqual(['auto', 'pick', 'HyperCharm · glm-5.3-flash', 'OpenCode · glm-5.3-flash'])
    // A trailing space lets the host accept a suggestion and send immediately.
    expect(items[0]!.value).toBe('auto ')
    expect(items[1]!.description).toContain('round-robin')
    expect(items[2]!.description).toBe('custom · current · this session + 1 other')
    // An account nobody is using is the one a fan-out should land on.
    expect(items[3]!.description).toBe('custom · no sessions')
  })

  it('omits a detail segment the caller did not supply', () => {
    const items = pickSuggestions({
      candidates: [{ id: 'a', label: 'work' }],
      pins: [],
      currentKey: 'k',
      currentId: undefined,
      policy: 'smoothed',
    })
    expect(items.at(-1)!.description).toBe('no sessions')
  })
})
