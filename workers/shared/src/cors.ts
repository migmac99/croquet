/**
 * CORS utilities for Croquet workers
 */

/** Standard CORS headers for cross-origin requests */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-API-Key, X-Croquet-Auth, X-Croquet-App, X-Croquet-Id, X-Croquet-Version, X-Croquet-Path, X-Croquet-Session',
  }
}

/** Handle CORS preflight request */
export function handleCors(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

/** Create JSON response with CORS headers */
export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders() })
}

/** Create error response with CORS headers */
export function errorResponse(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: corsHeaders() })
}
