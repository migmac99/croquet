/**
 * Croquet Registry Worker
 *
 * Handles session discovery and routing:
 * - Clients query registry to find which synchronizer hosts their session
 * - Validates API keys and checks domain whitelists
 *
 * Endpoints:
 *   GET  /dispatch?session={id}&app={appId}  → Returns synchronizer URL (requires API key)
 *   GET  /clients/join?meta=login            → API key verification (Multisynq/DePIN)
 *   POST /register                           → Synchronizer registers session
 *   POST /unregister                         → Synchronizer unregisters session
 *   GET  /sessions                           → List active sessions
 *   GET  /health                             → Health check
 *
 * Admin operations are handled by the Manager worker (synqmanager)
 */

import type { Env, SessionRecord, DispatchResponse, ApiKeyRecord, ApiKeyValidation } from './types'
import { corsHeaders, handleCors, jsonResponse, errorResponse, isOriginAllowed, getOrigin } from '@croquet/worker-shared'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // CORS
    if (request.method === 'OPTIONS') return handleCors()

    try {
      const path = url.pathname

      // Handle WebSocket connections - proxy to synchronizer
      if (path === '/clients/connect' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return handleClientsConnect(request, env, url)

      switch (path) {
        case '/dispatch':
          return handleDispatch(request, env)

        case '/register':
          return handleRegister(request, env)

        case '/unregister':
          return handleUnregister(request, env)

        case '/sessions':
          return handleListSessions(request, env)

        case '/synchronizers':
          return handleListSynchronizers(request, env)

        case '/clients/join':
          return handleClientsJoin(request, env)

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
  const originCheck = isOriginAllowed(getOrigin(request), record.allowedDomains)
  if (!originCheck.allowed) return { valid: false, error: originCheck.error }

  // Update last used (fire and forget) - update both key: and id: records
  const updated: ApiKeyRecord = {
    ...record,
    lastUsed: Date.now(),
    stats: {
      totalRequests: (record.stats?.totalRequests || 0) + 1,
      totalSessions: record.stats?.totalSessions || 0,
    },
  }
  env.APIKEYS.put(`key:${apiKey}`, JSON.stringify(updated))
  // Also update id: record (with redacted key) for UI display
  const { key: _, ...safeUpdated } = updated
  env.APIKEYS.put(`id:${record.id}`, JSON.stringify({ ...safeUpdated, key: '[REDACTED]' }))

  return {
    valid: true,
    keyId: record.id,
    tier: record.tier,
    accountId: record.accountId,
  }
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
    accountId: validation.accountId,
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
    colo?: string
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
    accountId: existing?.accountId,
    colo: body.colo || existing?.colo,
  }

  const ttl = Number(env.SESSION_TTL_SECONDS) || 3600
  await env.SESSIONS.put(body.sessionId, JSON.stringify(record), { expirationTtl: ttl })
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

/**
 * Synchronizer info aggregated from sessions
 */
interface SynchronizerInfo {
  url: string
  label: string
  sessionCount: number
  clientCount: number
  lastSeen: number
  region?: string
  lat?: number
  lon?: number
}

/**
 * Handle /synchronizers - List all active synchronizers with session/client counts
 * Supports ?out=map for GeoJSON format (for map visualization)
 */
async function handleListSynchronizers(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const outputFormat = url.searchParams.get('out')

  // Aggregate sessions by synchronizer URL
  const synchronizers = new Map<string, SynchronizerInfo>()

  let cursor: string | undefined
  do {
    const list = await env.SESSIONS.list({ cursor, limit: 1000 })

    for (const key of list.keys) {
      const session = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (!session) continue

      const syncUrl = session.synchronizerUrl || env.SYNCHRONIZER_URL
      const existing = synchronizers.get(syncUrl)

      if (existing) {
        existing.sessionCount++
        existing.clientCount += session.clientCount || 0
        existing.lastSeen = Math.max(existing.lastSeen, session.lastSeen)
      } else {
        // Try to extract region/location from URL or label
        const info = parseSynchronizerUrl(syncUrl, env.CLUSTER_LABEL)
        synchronizers.set(syncUrl, {
          url: syncUrl,
          label: info.label,
          sessionCount: 1,
          clientCount: session.clientCount || 0,
          lastSeen: session.lastSeen,
          region: info.region,
          lat: info.lat,
          lon: info.lon,
        })
      }
    }

    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  const syncList = Array.from(synchronizers.values()).sort((a, b) => b.sessionCount - a.sessionCount)

  // GeoJSON output for map visualization
  if (outputFormat === 'map') {
    const features = syncList
      .filter((s) => s.lat !== undefined && s.lon !== undefined)
      .map((s) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [s.lon!, s.lat!],
        },
        properties: {
          url: s.url,
          label: s.label,
          region: s.region,
          sessionCount: s.sessionCount,
          clientCount: s.clientCount,
          lastSeen: s.lastSeen,
        },
      }))

    return Response.json(
      {
        type: 'FeatureCollection',
        features,
        totals: {
          synchronizers: syncList.length,
          sessions: syncList.reduce((sum, s) => sum + s.sessionCount, 0),
          clients: syncList.reduce((sum, s) => sum + s.clientCount, 0),
        },
      },
      { headers: corsHeaders() }
    )
  }

  // Default: JSON list
  return Response.json(
    {
      count: syncList.length,
      synchronizers: syncList,
      totals: {
        sessions: syncList.reduce((sum, s) => sum + s.sessionCount, 0),
        clients: syncList.reduce((sum, s) => sum + s.clientCount, 0),
      },
    },
    { headers: corsHeaders() }
  )
}

/**
 * Parse synchronizer URL to extract region and approximate location
 * This uses known Cloudflare region codes or custom labels
 */
function parseSynchronizerUrl(url: string, defaultLabel: string): { label: string; region?: string; lat?: number; lon?: number } {
  // Known Cloudflare/region locations (approximate datacenter locations)
  const regionLocations: Record<string, { lat: number; lon: number; name: string }> = {
    // North America
    'us-west': { lat: 37.7749, lon: -122.4194, name: 'US West (San Francisco)' },
    'us-east': { lat: 39.0438, lon: -77.4874, name: 'US East (Virginia)' },
    'us-central': { lat: 41.8781, lon: -87.6298, name: 'US Central (Chicago)' },
    // Europe
    'eu-west': { lat: 53.3498, lon: -6.2603, name: 'EU West (Dublin)' },
    'eu-central': { lat: 50.1109, lon: 8.6821, name: 'EU Central (Frankfurt)' },
    'eu-north': { lat: 59.3293, lon: 18.0686, name: 'EU North (Stockholm)' },
    // Asia Pacific
    'ap-east': { lat: 35.6762, lon: 139.6503, name: 'AP East (Tokyo)' },
    'ap-southeast': { lat: 1.3521, lon: 103.8198, name: 'AP Southeast (Singapore)' },
    'ap-south': { lat: 19.076, lon: 72.8777, name: 'AP South (Mumbai)' },
    // South America
    'sa-east': { lat: -23.5505, lon: -46.6333, name: 'SA East (São Paulo)' },
    // Australia
    'au-east': { lat: -33.8688, lon: 151.2093, name: 'AU East (Sydney)' },
    // Fallback for local/dev
    local: { lat: 37.7749, lon: -122.4194, name: 'Local Development' },
    'local-dev': { lat: 37.7749, lon: -122.4194, name: 'Local Development' },
  }

  // Try to extract region from URL or use default label
  const urlLower = url.toLowerCase()
  let region: string | undefined
  let location: { lat: number; lon: number; name: string } | undefined

  // Check for region patterns in URL
  for (const [key, loc] of Object.entries(regionLocations)) {
    if (urlLower.includes(key) || defaultLabel.toLowerCase().includes(key)) {
      region = key
      location = loc
      break
    }
  }

  // If no region found, use default with local location
  if (!location && (urlLower.includes('localhost') || urlLower.includes('127.0.0.1'))) {
    region = 'local'
    location = regionLocations.local
  }

  return {
    label: location?.name || defaultLabel || url,
    region,
    lat: location?.lat,
    lon: location?.lon,
  }
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

/**
 * Handle /clients/connect - Proxy WebSocket connections to synchronizer
 * The Multisynq SDK uses the registry URL for both API verification and WebSocket connections
 */
async function handleClientsConnect(request: Request, env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get('session')
  if (!sessionId) return new Response('Missing session parameter', { status: 400 })

  // Build synchronizer URL with session ID in path
  // Convert ws:// to http:// and wss:// to https:// for fetch()
  // fetch() handles WebSocket upgrade via headers, not protocol
  const syncUrl = new URL(env.SYNCHRONIZER_URL)
  if (syncUrl.protocol === 'ws:') syncUrl.protocol = 'http:'
  else if (syncUrl.protocol === 'wss:') syncUrl.protocol = 'https:'
  syncUrl.pathname = `/${sessionId}`

  // Forward all query params except 'session' (already in path)
  url.searchParams.forEach((value, key) => {
    if (key !== 'session') syncUrl.searchParams.set(key, value)
  })

  console.log(`[registry] Proxying WebSocket to: ${syncUrl.toString()}`)

  // Forward the WebSocket request to synchronizer
  const syncRequest = new Request(syncUrl.toString(), {
    method: request.method,
    headers: request.headers,
  })

  return fetch(syncRequest)
}

/**
 * Handle /clients/join - API key verification for Multisynq/DePIN clients
 * Returns { developerId } on success, { error } on failure
 */
async function handleClientsJoin(request: Request, env: Env): Promise<Response> {
  // Get API key from X-Croquet-Auth header
  const apiKey = request.headers.get('X-Croquet-Auth')
  if (!apiKey) return errorResponse('Missing API key', 401)

  // Look up API key
  const record = await env.APIKEYS.get<ApiKeyRecord>(`key:${apiKey}`, 'json')
  if (!record) return errorResponse('Invalid API key', 403)
  if (!record.active) return errorResponse('API key is deactivated', 403)

  // Check domain whitelist
  const originCheck = isOriginAllowed(getOrigin(request), record.allowedDomains)
  if (!originCheck.allowed) return errorResponse(originCheck.error!, 403)

  // Update usage stats (fire and forget) - update both key: and id: records
  const updated: ApiKeyRecord = {
    ...record,
    lastUsed: Date.now(),
    stats: {
      totalRequests: (record.stats?.totalRequests || 0) + 1,
      totalSessions: record.stats?.totalSessions || 0,
    },
  }
  env.APIKEYS.put(`key:${apiKey}`, JSON.stringify(updated))
  // Also update id: record (with redacted key) for UI display
  const { key: _, ...safeUpdated } = updated
  env.APIKEYS.put(`id:${record.id}`, JSON.stringify({ ...safeUpdated, key: '[REDACTED]' }))

  // Return developerId (use the key owner's ID or a generated one)
  return jsonResponse({ developerId: record.metadata?.createdBy || record.id })
}
