/**
 * The synchronizer's admin session routes (/session/{id}/...), guarded in index.ts.
 */

/** The Durable Object path an admin session route goes to, with the methods each one takes. */
const SESSION_ROUTES: Record<string, { doPath: string; method: string }> = {
  '': { doPath: '/health', method: 'GET' },
  info: { doPath: '/info', method: 'GET' },
  snapshots: { doPath: '/snapshots', method: 'GET' },
  requ: { doPath: '/requ', method: 'POST' },
}

/** Read /session/{id}[/{sub}] into the DO route it names, or say why it is refused. */
export function sessionRoute(url: URL, method: string): { sessionId: string; doPath: string } | { error: string; status: number } | null {
  const parts = url.pathname.split('/').filter(Boolean) // ['session', '{id}', sub?]
  if (parts[0] !== 'session' || !parts[1] || parts.length > 3) return null
  const route = SESSION_ROUTES[parts[2] ?? '']
  if (!route) return null
  if (method !== route.method) return { error: 'Method not allowed', status: 405 }
  return { sessionId: parts[1], doPath: route.doPath } // raw, as the WebSocket path names the DO
}
