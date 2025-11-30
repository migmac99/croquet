/**
 * Croquet Synchronizer Worker
 *
 * Routes incoming WebSocket connections to session-specific Durable Objects.
 * Each session gets its own DO instance for isolation and scalability.
 */

import type { Env } from './types';
import { Synchronizer } from './synchronizer';

// Re-export DO class for wrangler
export { Synchronizer };

export default {
  /**
   * Main fetch handler - routes requests to appropriate DO
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    // Health check endpoint
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        cluster: env.CLUSTER_LABEL,
        version: env.PROTOCOL_VERSION,
        timestamp: Date.now(),
      }, { headers: corsHeaders() });
    }

    // Metrics endpoint (basic)
    if (url.pathname === '/metrics') {
      // TODO: Implement proper metrics
      return new Response('# Croquet Synchronizer Metrics\n', {
        headers: { 'Content-Type': 'text/plain', ...corsHeaders() },
      });
    }

    // Session info endpoint
    if (url.pathname.startsWith('/session/') && request.method === 'GET') {
      const sessionId = url.pathname.split('/')[2];
      if (sessionId) {
        const id = env.SYNCHRONIZER.idFromName(sessionId);
        const stub = env.SYNCHRONIZER.get(id);
        return stub.fetch(new Request(`${url.origin}/health`));
      }
    }

    // WebSocket upgrade - extract session from path
    // Expected format: /reflector/{sessionId} or /{version}/{sessionId}
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const sessionId = extractSessionId(url);

      if (!sessionId) {
        return new Response('Missing session ID', { status: 400 });
      }

      // Get or create DO for this session
      const id = env.SYNCHRONIZER.idFromName(sessionId);
      const stub = env.SYNCHRONIZER.get(id);

      // Forward to DO
      return stub.fetch(request);
    }

    // Default response
    return new Response(
      `Croquet Synchronizer ${env.PROTOCOL_VERSION}\nCluster: ${env.CLUSTER_LABEL}\n`,
      {
        headers: {
          'Content-Type': 'text/plain',
          'X-Powered-By': 'Croquet',
          ...corsHeaders(),
        },
      }
    );
  },
};

/**
 * Extract session ID from URL path
 * Supports:
 * - /reflector/{sessionId}
 * - /{version}/{sessionId}
 * - /{sessionId}
 */
function extractSessionId(url: URL): string | null {
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean);

  // Try query param first
  const fromQuery = url.searchParams.get('session');
  if (fromQuery) return fromQuery;

  // /reflector/{sessionId}
  if (parts[0] === 'reflector' && parts[1]) {
    return parts[1];
  }

  // /{version}/{sessionId} where version matches v1, v2, dev, etc.
  if (parts[0]?.match(/^(v\d+|dev)/) && parts[1]) {
    return parts[1];
  }

  // /{sessionId} - last segment
  if (parts.length > 0) {
    return parts[parts.length - 1];
  }

  return null;
}

/**
 * CORS headers for cross-origin requests
 */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Croquet-*',
  };
}

/**
 * Handle CORS preflight request
 */
function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}
