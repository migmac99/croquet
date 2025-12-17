/**
 * Croquet Synchronizer Worker
 *
 * Routes incoming WebSocket connections to session-specific Durable Objects.
 * Each session gets its own DO instance for isolation and scalability.
 */

import type { Env } from './types'
import { Synchronizer } from './synchronizer'
import { corsHeaders, handleCors, jsonResponse, errorResponse, isOriginAllowed, getOrigin } from '@croquet/worker-shared'

// Re-export DO class for wrangler
export { Synchronizer }

export default {
  /**
   * Main fetch handler - routes requests to appropriate DO
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === 'OPTIONS') return handleCors()

    // Health check endpoint
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      return Response.json(
        {
          status: 'ok',
          cluster: env.CLUSTER_LABEL,
          version: env.PROTOCOL_VERSION,
          timestamp: Date.now(),
        },
        { headers: corsHeaders() }
      )
    }

    // Metrics endpoint (basic)
    if (url.pathname === '/metrics') {
      // TODO: Implement proper metrics
      return new Response('# Croquet Synchronizer Metrics\n', {
        headers: { 'Content-Type': 'text/plain', ...corsHeaders() },
      })
    }

    // API key verification endpoint (for local dev / standalone mode)
    // In production, this is handled by the registry worker
    // SDK calls /sign/join?meta=login or /join?meta=login for key validation
    if (['/sign/join', '/clients/join', '/join'].includes(url.pathname)) return handleApiKeyValidation(request, env)

    // Session info endpoint
    if (url.pathname.startsWith('/session/') && request.method === 'GET') {
      const sessionId = url.pathname.split('/')[2]
      if (sessionId) {
        const id = env.SYNCHRONIZER.idFromName(sessionId)
        const stub = env.SYNCHRONIZER.get(id)
        return stub.fetch(new Request(`${url.origin}/health`))
      }
    }

    // WebSocket upgrade - extract session from path
    // Expected format: /reflector/{sessionId} or /{version}/{sessionId}
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const sessionId = extractSessionId(url)
      if (!sessionId) return new Response('Missing session ID', { status: 400 })

      // Get or create DO for this session
      const id = env.SYNCHRONIZER.idFromName(sessionId)
      const stub = env.SYNCHRONIZER.get(id)

      // Capture colo from request.cf (only available in main Worker, not in DO)
      const cf = request.cf as { colo?: string } | undefined
      const colo = cf?.colo

      // Forward to DO with session name and colo in headers (DO internal ID differs from name)
      const headers = new Headers([...request.headers.entries(), ['X-Session-Name', sessionId]])
      if (colo) headers.set('X-CF-Colo', colo)

      const forwardRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
      })
      return stub.fetch(forwardRequest)
    }

    // Default response
    return new Response(`Croquet Synchronizer ${env.PROTOCOL_VERSION}\nCluster: ${env.CLUSTER_LABEL}\n`, {
      headers: {
        'Content-Type': 'text/plain',
        'X-Powered-By': 'Croquet',
        ...corsHeaders(),
      },
    })
  },
}

/**
 * Extract session ID from URL path
 * Supports:
 * - /reflector/{sessionId}
 * - /{version}/{sessionId}
 * - /{sessionId}
 */
function extractSessionId(url: URL): string | null {
  const path = url.pathname
  const parts = path.split('/').filter(Boolean)

  // Try query param first
  const fromQuery = url.searchParams.get('session')
  if (fromQuery) return fromQuery

  // /reflector/{sessionId}
  if (parts[0] === 'reflector' && parts[1]) return parts[1]

  // /{version}/{sessionId} where version matches v1, v2, dev, etc.
  if (parts[0]?.match(/^(v\d+|dev)/) && parts[1]) return parts[1]

  // /{sessionId} - last segment
  if (parts.length > 0) return parts[parts.length - 1]

  return null
}

/**
 * Handle API key verification (/sign/join or /clients/join)
 * SDK calls /sign/join?meta=login for key validation
 * Validates API key using APIKEYS KV namespace
 */
async function handleApiKeyValidation(request: Request, env: Env): Promise<Response> {
  const apiKey = request.headers.get('X-Croquet-Auth')
  if (!apiKey) return errorResponse('Missing API key', 401)

  // Validate key format (client sends just the key portion, not the full formatted key):
  // - v1: "1randomhex" (deprecated Croquet.io)
  // - v2: "2randomhex" (WebRTC/DePIN mode)
  // - v3: "3randomhex" (Cloudflare Workers WebSocket mode)
  const isValid = /^[123]/.test(apiKey)
  if (!isValid) return errorResponse('Invalid API key format', 403)

  // Validate via APIKEYS KV
  if (env.APIKEYS) {
    const record = await env.APIKEYS.get<{
      id: string
      active: boolean
      allowedDomains: string[]
      metadata?: { createdBy?: string }
      lastUsed?: number
      stats?: { totalRequests?: number; totalSessions?: number }
    }>(`key:${apiKey}`, 'json')
    if (!record) return errorResponse('Invalid API key', 403)
    if (!record.active) return errorResponse('API key is deactivated', 403)

    // Check domain whitelist
    const originCheck = isOriginAllowed(getOrigin(request), record.allowedDomains)
    if (!originCheck.allowed) return errorResponse(originCheck.error!, 403)

    // Update usage stats (fire and forget)
    const updated = {
      ...record,
      lastUsed: Date.now(),
      stats: {
        totalRequests: (record.stats?.totalRequests || 0) + 1,
        totalSessions: record.stats?.totalSessions || 0,
      },
    }
    env.APIKEYS.put(`key:${apiKey}`, JSON.stringify(updated))

    console.log(`[sync] API key verified for ${record.id}`)
    return jsonResponse({ success: true })
  }

  // Fallback - format-only validation (for local dev without KV)
  console.log(`[sync] No APIKEYS KV available, using format-only validation`)
  return jsonResponse({ success: true })
}
