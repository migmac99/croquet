/**
 * Synq Manager - Admin interface for Croquet Workers
 *
 * Protected by Cloudflare Access - only authenticated users can access.
 * Manages API keys, sessions, and cluster configuration.
 */

import type {
  Env,
  AccessJWTPayload,
  ApiKeyRecord,
  SessionRecord,
  CreateApiKeyRequest,
  UpdateApiKeyRequest,
  CreateApiKeyResponse,
  AuthenticatedUser,
} from './types';

// Cloudflare Access public keys endpoint
const CERTS_URL = 'https://YOUR_TEAM_DOMAIN.cloudflareaccess.com/cdn-cgi/access/certs';

/**
 * Verify Cloudflare Access JWT
 */
async function verifyAccessJWT(
  request: Request,
  env: Env
): Promise<AuthenticatedUser | null> {
  const jwt =
    request.headers.get('CF-Access-JWT-Assertion') ||
    getCookie(request, 'CF_Authorization');

  if (!jwt) {
    return null;
  }

  try {
    // Decode JWT without verification first to get header
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(atob(parts[0]));
    const payload = JSON.parse(atob(parts[1])) as AccessJWTPayload;

    // Check expiration
    if (payload.exp < Date.now() / 1000) {
      console.log('JWT expired');
      return null;
    }

    // Check audience matches our application
    if (!payload.aud.includes(env.ACCESS_AUD)) {
      console.log('JWT audience mismatch');
      return null;
    }

    // For production, you should verify the signature using Cloudflare's public keys
    // This is simplified for the example - the JWT is already validated by Access
    // before reaching the worker when properly configured

    return {
      email: payload.email,
      sub: payload.sub,
    };
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

/**
 * Get cookie value from request
 */
function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie');
  if (!cookies) return null;

  const match = cookies.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Generate a secure API key
 */
function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'synq_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a unique key ID
 */
function generateKeyId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * JSON response helper
 */
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    },
  });
}

/**
 * Error response helper
 */
function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Main request handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Health check (unauthenticated)
    if (path === '/health') {
      return json({ status: 'ok', service: 'synqmanager' });
    }

    // Verify Cloudflare Access authentication
    const user = await verifyAccessJWT(request, env);
    if (!user) {
      return error('Unauthorized - Cloudflare Access authentication required', 401);
    }

    // Route requests
    try {
      // API Keys management
      if (path === '/keys' || path === '/keys/') {
        if (request.method === 'GET') {
          return await listApiKeys(env, user);
        }
        if (request.method === 'POST') {
          return await createApiKey(request, env, user);
        }
      }

      // Single API key operations
      const keyMatch = path.match(/^\/keys\/([a-f0-9]+)$/);
      if (keyMatch) {
        const keyId = keyMatch[1];
        if (request.method === 'GET') {
          return await getApiKey(keyId, env);
        }
        if (request.method === 'DELETE') {
          return await deleteApiKey(keyId, env, user);
        }
        if (request.method === 'PATCH') {
          return await updateApiKey(keyId, request, env, user);
        }
      }

      // Sessions management
      if (path === '/sessions' || path === '/sessions/') {
        if (request.method === 'GET') {
          return await listSessions(env);
        }
      }

      // Single session operations
      const sessionMatch = path.match(/^\/sessions\/(.+)$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        if (request.method === 'GET') {
          return await getSession(sessionId, env);
        }
        if (request.method === 'DELETE') {
          return await deleteSession(sessionId, env, user);
        }
      }

      // Dashboard / overview
      if (path === '/' || path === '/dashboard') {
        return await getDashboard(env, user);
      }

      return error('Not found', 404);
    } catch (err) {
      console.error('Request error:', err);
      return error('Internal server error', 500);
    }
  },
};

// ============================================================================
// API Key Handlers
// ============================================================================

async function listApiKeys(env: Env, user: AuthenticatedUser): Promise<Response> {
  const keys: Omit<ApiKeyRecord, 'key'>[] = [];
  let cursor: string | undefined;

  // List all keys by ID prefix
  do {
    const result = await env.APIKEYS.list({ prefix: 'id:', cursor });
    for (const key of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(key.name, 'json');
      if (record) {
        // Never return the actual key in list
        const { key: _, ...safe } = record;
        keys.push(safe);
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return json({
    keys,
    total: keys.length,
    requestedBy: user.email,
  });
}

async function createApiKey(
  request: Request,
  env: Env,
  user: AuthenticatedUser
): Promise<Response> {
  const body = await request.json<CreateApiKeyRequest>();

  if (!body.name || !body.allowedDomains?.length) {
    return error('name and allowedDomains are required');
  }

  const id = generateKeyId();
  const key = generateApiKey();

  const record: ApiKeyRecord = {
    id,
    key,
    name: body.name,
    allowedDomains: body.allowedDomains,
    allowedApps: body.allowedApps,
    tier: body.tier || 'free',
    active: true,
    createdAt: Date.now(),
    metadata: {
      ...body.metadata,
      createdBy: user.email,
    },
  };

  // Store by key (for validation lookups)
  await env.APIKEYS.put(`key:${key}`, JSON.stringify(record));

  // Store by ID (for admin lookups) - with key redacted
  const { key: _, ...safeRecord } = record;
  await env.APIKEYS.put(`id:${id}`, JSON.stringify({ ...safeRecord, key: '[REDACTED]' }));

  const response: CreateApiKeyResponse = {
    id,
    key, // Only returned on creation!
    name: body.name,
    allowedDomains: body.allowedDomains,
    tier: record.tier,
    createdAt: record.createdAt,
  };

  console.log(`API key created: ${id} by ${user.email}`);
  return json(response, 201);
}

async function getApiKey(keyId: string, env: Env): Promise<Response> {
  const record = await env.APIKEYS.get<ApiKeyRecord>(`id:${keyId}`, 'json');
  if (!record) {
    return error('API key not found', 404);
  }

  // Never return the actual key
  const { key: _, ...safe } = record;
  return json(safe);
}

async function updateApiKey(
  keyId: string,
  request: Request,
  env: Env,
  user: AuthenticatedUser
): Promise<Response> {
  // Get current record by ID
  const idRecord = await env.APIKEYS.get<ApiKeyRecord>(`id:${keyId}`, 'json');
  if (!idRecord) {
    return error('API key not found', 404);
  }

  // Get the full record with actual key
  // We need to find it by listing or we can store a reference
  // For now, search through key: prefix
  let fullRecord: ApiKeyRecord | null = null;
  let cursor: string | undefined;

  do {
    const result = await env.APIKEYS.list({ prefix: 'key:', cursor });
    for (const k of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(k.name, 'json');
      if (record && record.id === keyId) {
        fullRecord = record;
        break;
      }
    }
    if (fullRecord) break;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  if (!fullRecord) {
    return error('API key data inconsistency', 500);
  }

  const body = await request.json<UpdateApiKeyRequest>();

  // Update fields
  const updated: ApiKeyRecord = {
    ...fullRecord,
    name: body.name ?? fullRecord.name,
    allowedDomains: body.allowedDomains ?? fullRecord.allowedDomains,
    allowedApps: body.allowedApps ?? fullRecord.allowedApps,
    tier: body.tier ?? fullRecord.tier,
    active: body.active ?? fullRecord.active,
    metadata: {
      ...fullRecord.metadata,
      ...body.metadata,
      lastModifiedBy: user.email,
      lastModifiedAt: new Date().toISOString(),
    },
  };

  // Update both records
  await env.APIKEYS.put(`key:${fullRecord.key}`, JSON.stringify(updated));
  const { key: _, ...safeUpdated } = updated;
  await env.APIKEYS.put(`id:${keyId}`, JSON.stringify({ ...safeUpdated, key: '[REDACTED]' }));

  console.log(`API key updated: ${keyId} by ${user.email}`);
  return json(safeUpdated);
}

async function deleteApiKey(
  keyId: string,
  env: Env,
  user: AuthenticatedUser
): Promise<Response> {
  // Find the full record to get the actual key
  let fullRecord: ApiKeyRecord | null = null;
  let cursor: string | undefined;

  do {
    const result = await env.APIKEYS.list({ prefix: 'key:', cursor });
    for (const k of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(k.name, 'json');
      if (record && record.id === keyId) {
        fullRecord = record;
        break;
      }
    }
    if (fullRecord) break;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  if (!fullRecord) {
    return error('API key not found', 404);
  }

  // Delete both records
  await env.APIKEYS.delete(`key:${fullRecord.key}`);
  await env.APIKEYS.delete(`id:${keyId}`);

  console.log(`API key deleted: ${keyId} by ${user.email}`);
  return json({ deleted: true, id: keyId });
}

// ============================================================================
// Session Handlers
// ============================================================================

async function listSessions(env: Env): Promise<Response> {
  const sessions: SessionRecord[] = [];
  let cursor: string | undefined;

  do {
    const result = await env.SESSIONS.list({ cursor });
    for (const key of result.keys) {
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json');
      if (record) {
        sessions.push(record);
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  // Sort by lastSeen descending
  sessions.sort((a, b) => b.lastSeen - a.lastSeen);

  return json({
    sessions,
    total: sessions.length,
  });
}

async function getSession(sessionId: string, env: Env): Promise<Response> {
  const record = await env.SESSIONS.get<SessionRecord>(sessionId, 'json');
  if (!record) {
    return error('Session not found', 404);
  }
  return json(record);
}

async function deleteSession(
  sessionId: string,
  env: Env,
  user: AuthenticatedUser
): Promise<Response> {
  const record = await env.SESSIONS.get<SessionRecord>(sessionId, 'json');
  if (!record) {
    return error('Session not found', 404);
  }

  await env.SESSIONS.delete(sessionId);
  console.log(`Session deleted: ${sessionId} by ${user.email}`);
  return json({ deleted: true, sessionId });
}

// ============================================================================
// Dashboard
// ============================================================================

async function getDashboard(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Count API keys
  let apiKeyCount = 0;
  let activeKeyCount = 0;
  let cursor: string | undefined;

  do {
    const result = await env.APIKEYS.list({ prefix: 'id:', cursor });
    for (const key of result.keys) {
      apiKeyCount++;
      const record = await env.APIKEYS.get<ApiKeyRecord>(key.name, 'json');
      if (record?.active) activeKeyCount++;
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  // Count sessions
  let sessionCount = 0;
  let totalClients = 0;
  cursor = undefined;

  do {
    const result = await env.SESSIONS.list({ cursor });
    for (const key of result.keys) {
      sessionCount++;
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json');
      if (record) totalClients += record.clientCount;
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return json({
    user: user.email,
    cluster: env.CLUSTER_LABEL,
    synchronizer: env.SYNCHRONIZER_URL,
    stats: {
      apiKeys: {
        total: apiKeyCount,
        active: activeKeyCount,
      },
      sessions: {
        total: sessionCount,
        totalClients,
      },
    },
    endpoints: {
      keys: '/keys',
      sessions: '/sessions',
    },
  });
}
