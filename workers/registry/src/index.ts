/**
 * Croquet Registry Worker
 *
 * Handles session discovery and routing:
 * - Clients query registry to find which synchronizer hosts their session
 * - Validates API keys and checks domain whitelists
 *
 * Endpoints:
 *   GET  /dispatch?session={id}&app={appId}  → Returns synchronizer URL (requires API key)
 *   POST /register                           → Synchronizer registers session
 *   POST /unregister                         → Synchronizer unregisters session
 *   GET  /sessions                           → List active sessions
 *   GET  /health                             → Health check
 *
 * Admin operations are handled by the Manager worker (synqmanager)
 */

import type { Env, SessionRecord, DispatchResponse, ApiKeyRecord, ApiKeyValidation } from './types'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // CORS
    if (request.method === 'OPTIONS') return handleCors()

    try {
      const path = url.pathname

      switch (path) {
        case '/dispatch':
          return handleDispatch(request, env)

        case '/register':
          return handleRegister(request, env)

        case '/unregister':
          return handleUnregister(request, env)

        case '/sessions':
          return handleListSessions(request, env)

        case '/health':
        case '/healthz':
          return handleHealth(env)

        default:
          return new Response(`Croquet Registry\nCluster: ${env.CLUSTER_LABEL}\nSynchronizer: ${env.SYNCHRONIZER_URL}\n`, {
            headers: { 'Content-Type': 'text/plain', ...corsHeaders() },
          })
      }
    } catch (err) {
      console.error('Registry error:', err)
      return Response.json({ error: 'Internal error', message: String(err) }, { status: 500, headers: corsHeaders() })
    }
  },
}

// ============================================================================
// API Key Validation
// ============================================================================

/**
 * Validate API key and check domain whitelist
 */
async function validateApiKey(request: Request, env: Env): Promise<ApiKeyValidation> {
  // Get API key from header or query param
  const url = new URL(request.url)
  const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '') || url.searchParams.get('apiKey')
  if (!apiKey) return { valid: false, error: 'Missing API key' }

  // Look up API key
  const record = await env.APIKEYS.get<ApiKeyRecord>(`key:${apiKey}`, 'json')
  if (!record) return { valid: false, error: 'Invalid API key' }
  if (!record.active) return { valid: false, error: 'API key is deactivated' }

  // Check domain whitelist
  const origin = request.headers.get('Origin') || request.headers.get('Referer')
  if (origin && record.allowedDomains.length > 0) {
    const originHost = extractHost(origin)
    const allowed = record.allowedDomains.some((pattern) => matchDomain(originHost, pattern))

    if (!allowed) {
      return {
        valid: false,
        error: `Domain '${originHost}' not allowed for this API key`,
      }
    }
  }

  // Update last used (fire and forget)
  const updated: ApiKeyRecord = {
    ...record,
    lastUsed: Date.now(),
    stats: {
      totalRequests: (record.stats?.totalRequests || 0) + 1,
      totalSessions: record.stats?.totalSessions || 0,
    },
  }
  env.APIKEYS.put(`key:${apiKey}`, JSON.stringify(updated))

  return {
    valid: true,
    keyId: record.id,
    tier: record.tier,
  }
}

/**
 * Extract hostname from URL
 */
function extractHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Match domain against pattern (supports wildcards)
 * Examples:
 *   - "example.com" matches "example.com"
 *   - "*.example.com" matches "sub.example.com", "a.b.example.com"
 *   - "*" matches everything
 *   - "localhost" matches "localhost"
 *   - "localhost:*" matches "localhost:3000", "localhost:8080"
 */
function matchDomain(domain: string, pattern: string): boolean {
  if (pattern === domain) return true // Exact match
  if (pattern === '*') return true // Wildcard all

  // Port wildcard (localhost:*)
  if (pattern.endsWith(':*')) {
    const base = pattern.slice(0, -2)
    return domain === base || domain.startsWith(base + ':')
  }

  // Subdomain wildcard (*.example.com)
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.slice(2)
    return domain === baseDomain || domain.endsWith('.' + baseDomain)
  }

  return false
}

// ============================================================================
// Dispatch Handler
// ============================================================================

/**
 * Dispatch: Find synchronizer for a session
 *
 * GET /dispatch?session={sessionId}&app={appId}
 * Headers: X-API-Key: {key}
 */
async function handleDispatch(request: Request, env: Env): Promise<Response> {
  // Check if API key is required
  const requireKey = env.REQUIRE_API_KEY === 'true'

  let validation: ApiKeyValidation = { valid: true }

  if (requireKey) {
    validation = await validateApiKey(request, env)
    if (!validation.valid) return Response.json({ error: 'Unauthorized', message: validation.error }, { status: 401, headers: corsHeaders() })
  }

  const url = new URL(request.url)
  const appId = url.searchParams.get('app')

  const sessionId = url.searchParams.get('session')
  if (!sessionId) return Response.json({ error: 'Missing session parameter' }, { status: 400, headers: corsHeaders() })

  // Check for existing session
  const existing = await env.SESSIONS.get<SessionRecord>(sessionId, 'json')

  if (existing) {
    // Update last seen
    existing.lastSeen = Date.now()
    const ttl = Number(env.SESSION_TTL_SECONDS) || 3600
    await env.SESSIONS.put(sessionId, JSON.stringify(existing), { expirationTtl: ttl })

    return Response.json(
      {
        synchronizer: existing.synchronizerUrl,
        sessionId: existing.sessionId,
        existing: true,
      } satisfies DispatchResponse & { existing: boolean },
      { headers: corsHeaders() }
    )
  }

  // New session - assign to default synchronizer
  const record: SessionRecord = {
    sessionId,
    synchronizerUrl: env.SYNCHRONIZER_URL,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    clientCount: 0,
    appId: appId || undefined,
    apiKeyId: validation.keyId,
  }

  const ttl = Number(env.SESSION_TTL_SECONDS) || 3600
  await env.SESSIONS.put(sessionId, JSON.stringify(record), { expirationTtl: ttl })

  return Response.json(
    {
      synchronizer: record.synchronizerUrl,
      sessionId: record.sessionId,
      existing: false,
    } satisfies DispatchResponse & { existing: boolean },
    { headers: corsHeaders() }
  )
}

// ============================================================================
// Session Management
// ============================================================================

async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders() })

  const body = await request.json<{
    sessionId: string
    clientCount?: number
    appId?: string
    synchronizerUrl?: string
  }>()

  if (!body.sessionId) return Response.json({ error: 'Missing sessionId' }, { status: 400, headers: corsHeaders() })

  const existing = await env.SESSIONS.get<SessionRecord>(body.sessionId, 'json')

  const record: SessionRecord = {
    sessionId: body.sessionId,
    synchronizerUrl: body.synchronizerUrl || env.SYNCHRONIZER_URL,
    createdAt: existing?.createdAt || Date.now(),
    lastSeen: Date.now(),
    clientCount: body.clientCount ?? existing?.clientCount ?? 0,
    appId: body.appId || existing?.appId,
    apiKeyId: existing?.apiKeyId,
  }

  const ttl = Number(env.SESSION_TTL_SECONDS) || 3600
  await env.SESSIONS.put(body.sessionId, JSON.stringify(record), {
    expirationTtl: ttl,
  })

  return Response.json({ success: true, record }, { headers: corsHeaders() })
}

async function handleUnregister(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders() })

  const body = await request.json<{ sessionId: string }>()
  if (!body.sessionId) return Response.json({ error: 'Missing sessionId' }, { status: 400, headers: corsHeaders() })

  await env.SESSIONS.delete(body.sessionId)
  return Response.json({ success: true }, { headers: corsHeaders() })
}

async function handleListSessions(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const prefix = url.searchParams.get('prefix') || ''
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000)

  const list = await env.SESSIONS.list({ prefix, limit })

  const sessions: SessionRecord[] = []
  for (const key of list.keys) {
    const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
    if (record) sessions.push(record)
  }

  return Response.json(
    {
      count: sessions.length,
      sessions,
      cursor: list.list_complete ? null : list.cursor,
    },
    { headers: corsHeaders() }
  )
}

async function handleHealth(env: Env): Promise<Response> {
  return Response.json(
    {
      status: 'ok',
      cluster: env.CLUSTER_LABEL,
      synchronizer: env.SYNCHRONIZER_URL,
      requireApiKey: env.REQUIRE_API_KEY === 'true',
      timestamp: Date.now(),
    },
    { headers: corsHeaders() }
  )
}

// ============================================================================
// Utilities
// ============================================================================

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  }
}

function handleCors(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() })
}
