import type { Api, Model, ProviderHeaders } from '@earendil-works/pi-ai'

// pi core injects session-routing headers from the *session* model
// (mergeProviderAttributionHeaders): x-opencode-session / x-opencode-client
// for the opencode family. A virtual provider's session model is the virtual
// identity — provider id and baseUrl advertised from the first backend — so
// requests the virtual stream dispatches to a backing provider would miss
// them, and opencode.ai rejects such requests with 400 MissingSessionID.
// This mirrors that core rule, keyed on the model actually dispatched, so
// backends receive the same session pin a direct request would carry. Keep
// in sync with pi core's provider-attribution.ts (getSessionHeaders).

const OPENCODE_HOST = 'opencode.ai'

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return undefined
  }
}

export function sessionAttributionHeaders(
  model: Pick<Model<Api>, 'provider' | 'baseUrl'>,
  sessionId: string | undefined,
): ProviderHeaders {
  if (!sessionId) return {}
  const isOpencodeFamily = model.provider === 'opencode'
    || model.provider === 'opencode-go'
    || hostOf(model.baseUrl) === OPENCODE_HOST
  if (!isOpencodeFamily) return {}
  return { 'x-opencode-session': sessionId, 'x-opencode-client': 'pi' }
}
