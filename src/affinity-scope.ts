import type { StreamOptions } from '@earendil-works/pi-ai'

// Affinity scope for one dispatch: the identity a request's backend (or
// account) selection is pinned to.
//
// pi core carries the requesting session's id on the stream options
// (`sessionId`, defined for provider session routing and cache pinning), so an
// embedding host that runs its own AgentSessions — pi-fabric agents, a workflow
// runner — is distinguishable from the caller alone: each nested agent gets its
// own stickiness instead of every one inheriting the host session's pin. When a
// caller declares nothing we fall back to the host session id the extension
// resolves from its own context.
//
// undefined means "no identity": the scheduler then selects purely by policy.
// Collapsing every identity-less caller onto one shared key would silently pin
// unrelated sessions to whichever one asked first.
export function affinityScope(
  options: Pick<StreamOptions, 'sessionId'> | undefined,
  fallback?: string,
): string | undefined {
  const scoped = typeof options?.sessionId === 'string' ? options.sessionId.trim() : ''
  if (scoped !== '') return scoped
  const host = fallback?.trim()
  return host === undefined || host === '' ? undefined : host
}
