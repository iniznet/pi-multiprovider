import type { AffinityEntry } from './types.ts'

// Argument suggestions for the switch/pick command. Structurally matches pi's
// AutocompleteItem ({ value, label, description? }) so src stays free of the
// TUI import; the extension hands these straight to registerCommand.
export interface PickSuggestion {
  value: string
  label: string
  description?: string
}

export interface PickCandidate {
  id: string
  label: string
  /** Provider/auth detail shown alongside the label. */
  detail?: string
}

/**
 * Who sits on one account, phrased from the caller's point of view. "this
 * session" and "3 others" read very differently when deciding where to land a
 * new agent, and "no sessions" is the signal that an account is idle.
 */
export function sessionsOn(
  pins: readonly AffinityEntry[],
  accountId: string,
  currentKey: string,
): string | undefined {
  const onAccount = pins.filter(pin => pin.accountId === accountId)
  if (onAccount.length === 0) return undefined
  const here = onAccount.some(pin => pin.key === currentKey)
  const others = onAccount.length - (here ? 1 : 0)
  const parts: string[] = []
  if (here) parts.push('this session')
  if (others > 0) parts.push(`${others} other${others === 1 ? '' : 's'}`)
  return parts.join(' + ')
}

export interface PickSuggestionInput {
  candidates: readonly PickCandidate[]
  pins: readonly AffinityEntry[]
  /** The calling session's affinity key, for the "this session" wording. */
  currentKey: string
  /** Account this session is currently pinned to, if any. */
  currentId: string | undefined
  /** Pool policy name, so the automatic rows describe what they will do. */
  policy: string
}

/**
 * Argument list for the switch command: the two automatic modes first, then one
 * row per candidate account describing its state and which sessions are already
 * attached. Values carry a trailing space so accepting a suggestion leaves the
 * caret ready to send the command.
 */
export function pickSuggestions(input: PickSuggestionInput): PickSuggestion[] {
  const { candidates, pins, currentKey, currentId, policy } = input
  const rows = candidates.map(candidate => {
    const attached = sessionsOn(pins, candidate.id, currentKey)
    const description = [
      candidate.detail,
      candidate.id === currentId ? 'current' : undefined,
      attached ?? 'no sessions',
    ].filter((part): part is string => part !== undefined && part !== '').join(' · ')
    return {
      value: candidate.label + ' ',
      label: candidate.label,
      ...(description === '' ? {} : { description }),
    }
  })
  return [
    {
      value: 'auto ',
      label: 'auto',
      description: `release this session's pin and let the ${policy} strategy choose`,
    },
    {
      value: 'pick ',
      label: 'pick',
      description: `run the ${policy} strategy now and pin the result for this session`,
    },
    ...rows,
  ]
}
