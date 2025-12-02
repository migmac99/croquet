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
  AccountRecord,
  CreateAccountRequest,
  UpdateAccountRequest,
} from './types'
import { renderDashboard, renderKeysPage, renderSessionsPage, renderAccountsPage, renderSynchronizersPage, renderMapPage } from './ui'

/**
 * Verify Bearer token auth against stored account secrets
 * Returns the account if valid, null otherwise
 */
async function verifyAccountSecret(request: Request, accountId: string, env: Env): Promise<{ account: AccountRecord; user: AuthenticatedUser } | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  const secret = authHeader.slice(7)
  if (!secret) return null

  // Look up account by secret
  const account = await env.ACCOUNTS.get<AccountRecord>(`secret:${secret}`, 'json')
  if (!account) return null

  // Verify account ID matches URL path
  if (account.id !== accountId) {
    console.log(`Account ID mismatch: expected ${accountId}, got ${account.id}`)
    return null
  }

  // Verify account is active
  if (!account.active) {
    console.log(`Account ${accountId} is inactive`)
    return null
  }

  // Update last used timestamp (non-blocking)
  const updated = { ...account, lastUsed: Date.now() }
  env.ACCOUNTS.put(`secret:${secret}`, JSON.stringify(updated))
  env.ACCOUNTS.put(`id:${accountId}`, JSON.stringify(updated))

  return {
    account,
    user: {
      email: `account:${account.name}`,
      sub: account.id,
    },
  }
}

/**
 * Generate a unique account ID (16 hex chars)
 */
function generateAccountId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a secure account secret (64 hex chars)
 */
function generateAccountSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Verify Cloudflare Access JWT
 */
async function verifyAccessJWT(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  const jwt = request.headers.get('CF-Access-JWT-Assertion') || getCookie(request, 'CF_Authorization')
  if (!jwt) return null

  try {
    // Decode JWT without verification first to get header
    const parts = jwt.split('.')
    if (parts.length !== 3) return null

    const header = JSON.parse(atob(parts[0]))
    const payload = JSON.parse(atob(parts[1])) as AccessJWTPayload

    // Check expiration
    if (payload.exp < Date.now() / 1000) {
      console.log('JWT expired')
      return null
    }

    // Check audience matches our application
    if (!payload.aud.includes(env.ACCESS_AUD)) {
      console.log('JWT audience mismatch')
      return null
    }

    // For production, you should verify the signature using Cloudflare's public keys
    // This is simplified for the example - the JWT is already validated by Access
    // before reaching the worker when properly configured

    return {
      email: payload.email,
      sub: payload.sub,
    }
  } catch (error) {
    console.error('JWT verification failed:', error)
    return null
  }
}

/**
 * Get cookie value from request
 */
function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie')
  if (!cookies) return null

  const match = cookies.match(new RegExp(`${name}=([^;]+)`))
  return match ? match[1] : null
}

/**
 * Generate a secure API key (the part used for authentication)
 * Format: version digit + 48 hex chars
 * - v1: "1xxx" (deprecated Croquet.io - requires reflector URL embedded)
 * - v2: "2xxx" (WebRTC/DePIN mode)
 * - v3: "3xxx" (Cloudflare Workers WebSocket mode)
 *
 * Note: Only v1 keys have reflector URL embedded ("reflectorUrl:1xxx") for
 * legacy client compatibility. v2/v3 keys are just "2xxx" or "3xxx".
 */
function generateApiKey(version: 1 | 2 | 3): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const randomPart = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

  // All versions use same format: version digit + random hex
  return `${version}${randomPart}`
}

/**
 * Generate a unique key ID
 */
function generateKeyId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
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
  })
}

/**
 * Error response helper
 */
function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

/**
 * HTML response helper
 */
function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  })
}

/**
 * Main request handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // Health check (unauthenticated)
    if (path === '/health') return json({ status: 'ok', service: 'synqmanager' })

    // Skip auth for localhost (dev mode)
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    let user: AuthenticatedUser | null = null

    if (isLocalhost) user = { email: 'dev@localhost', sub: 'dev' }
    else {
      // Production - verify Cloudflare Access JWT
      user = await verifyAccessJWT(request, env)
      if (!user) return error('Unauthorized - Cloudflare Access authentication required', 401)
    }

    // Route requests
    try {
      // ========================================
      // UI Routes (HTML pages)
      // ========================================

      if (path === '/' || path === '/dashboard') return await getDashboardUI(env, user) // Dashboard UI
      if (path === '/ui/keys') return await getKeysUI(env, user) // Keys UI
      if (path === '/ui/sessions') return await getSessionsUI(env, user) // Sessions UI
      if (path === '/ui/accounts') return await getAccountsUI(env, user) // Accounts UI
      if (path === '/ui/synchronizers') return await getSynchronizersUI(env, user) // Synchronizers UI
      if (path === '/ui/map') return await getMapUI(env, user) // Map UI

      // ========================================
      // API Routes (JSON)
      // ========================================

      // API Keys management
      if (path === '/keys' || path === '/keys/') {
        if (request.method === 'GET') return await listApiKeys(env, user)
        if (request.method === 'POST') return await createApiKey(request, env, user)
      }

      // Single API key operations
      const keyMatch = path.match(/^\/keys\/([a-f0-9]+)$/)
      if (keyMatch) {
        const keyId = keyMatch[1]
        if (request.method === 'GET') return await getApiKey(keyId, env)
        if (request.method === 'DELETE') return await deleteApiKey(keyId, env, user)
        if (request.method === 'PATCH') return await updateApiKey(keyId, request, env, user)
      }

      // Roll (regenerate) API key
      const rollMatch = path.match(/^\/keys\/([a-f0-9]+)\/roll$/)
      if (rollMatch && request.method === 'POST') return await rollApiKey(rollMatch[1], env, user)

      // Sessions management
      if (path === '/sessions' || path === '/sessions/') {
        if (request.method === 'GET') return await listSessions(env)
      }

      // Single session operations
      const sessionMatch = path.match(/^\/sessions\/(.+)$/)
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1])
        if (request.method === 'GET') return await getSession(sessionId, env)
        if (request.method === 'DELETE') return await deleteSession(sessionId, env, user)
      }

      // ========================================
      // MultiSynq DePIN API Compatibility Routes
      // ========================================
      // These routes match the original api.multisynq.io/depin API structure
      // so existing applications only need to change API_URL

      // Create key: GET /depin/coders/{accountId}/create-key?name=X&urls=X&dev=X
      const createKeyMatch = path.match(/^\/depin\/coders\/([^/]+)\/create-key$/)
      if (createKeyMatch) {
        const accountId = createKeyMatch[1]
        const auth = await verifyAccountSecret(request, accountId, env)
        if (!auth) return error('Unauthorized - Invalid account credentials', 401)
        return await depinCreateKey(url, env, auth.account, auth.user)
      }

      // Read keys: GET /depin/coders/{accountId}/read?what=keys,usage
      const readMatch = path.match(/^\/depin\/coders\/([^/]+)\/read$/)
      if (readMatch) {
        const accountId = readMatch[1]
        const auth = await verifyAccountSecret(request, accountId, env)
        if (!auth) return error('Unauthorized - Invalid account credentials', 401)
        return await depinReadKeys(env, auth.account)
      }

      // Update key: GET /depin/coders/{accountId}/key/{key}/update?urls=X&dev=X
      const updateKeyMatch = path.match(/^\/depin\/coders\/([^/]+)\/key\/([^/]+)\/update$/)
      if (updateKeyMatch) {
        const accountId = updateKeyMatch[1]
        const auth = await verifyAccountSecret(request, accountId, env)
        if (!auth) return error('Unauthorized - Invalid account credentials', 401)
        const keyValue = updateKeyMatch[2]
        return await depinUpdateKey(keyValue, url, env, auth.account, auth.user)
      }

      // Delete key: GET /depin/coders/{accountId}/key/{key}/delete
      const deleteKeyMatch = path.match(/^\/depin\/coders\/([^/]+)\/key\/([^/]+)\/delete$/)
      if (deleteKeyMatch) {
        const accountId = deleteKeyMatch[1]
        const auth = await verifyAccountSecret(request, accountId, env)
        if (!auth) return error('Unauthorized - Invalid account credentials', 401)
        const keyValue = deleteKeyMatch[2]
        return await depinDeleteKey(keyValue, env, auth.account, auth.user)
      }

      // ========================================
      // Account Management Routes (Admin only)
      // ========================================

      // List/Create accounts
      if (path === '/accounts' || path === '/accounts/') {
        if (request.method === 'GET') return await listAccounts(env, user)
        if (request.method === 'POST') return await createAccount(request, env, user)
      }

      // Single account operations
      const accountMatch = path.match(/^\/accounts\/([a-f0-9]+)$/)
      if (accountMatch) {
        const accountId = accountMatch[1]
        if (request.method === 'GET') return await getAccount(accountId, env)
        if (request.method === 'DELETE') return await deleteAccount(accountId, env, user)
        if (request.method === 'PATCH') return await updateAccount(accountId, request, env, user)
      }

      // Roll (regenerate) account secret
      const rollAccountMatch = path.match(/^\/accounts\/([a-f0-9]+)\/roll$/)
      if (rollAccountMatch && request.method === 'POST') return await rollAccountSecret(rollAccountMatch[1], env, user)

      return error('Not found', 404)
    } catch (err) {
      console.error('Request error:', err)
      return error('Internal server error', 500)
    }
  },
}

// ============================================================================
// API Key Handlers
// ============================================================================

async function listApiKeys(env: Env, user: AuthenticatedUser): Promise<Response> {
  const keys: Omit<ApiKeyRecord, 'key'>[] = []
  let cursor: string | undefined

  // List all keys by ID prefix
  do {
    const result = await env.APIKEYS.list({ prefix: 'id:', cursor })
    for (const key of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(key.name, 'json')
      if (record) {
        // Never return the actual key in list
        const { key: _, ...safe } = record
        keys.push(safe)
      }
    }
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  return json({
    keys,
    total: keys.length,
    requestedBy: user.email,
  })
}

async function createApiKey(request: Request, env: Env, user: AuthenticatedUser): Promise<Response> {
  const body = await request.json<CreateApiKeyRequest>()
  if (!body.name || !body.allowedDomains?.length) return error('name and allowedDomains are required')

  // Default to v3 (Cloudflare Workers WebSocket)
  const version = body.version || 3

  // Only v1 (legacy) keys require a reflector URL embedded in the key
  // v2 (DePIN) and v3 (Cloudflare Workers) are configured separately
  const needsReflector = version === 1
  const reflectorUrl = needsReflector ? body.reflectorUrl || env.SYNCHRONIZER_URL : undefined
  if (needsReflector && !reflectorUrl) return error('reflectorUrl is required for v1 keys (or set SYNCHRONIZER_URL)')

  const id = generateKeyId()
  const key = generateApiKey(version) // e.g., "1abc123", "2abc123", or "3abc123"

  // For v1 keys: embed reflector URL for legacy client compatibility
  // Format: "ws://example.com:1abc123" - client uses lastIndexOf(':') to parse
  const formattedKey = needsReflector ? `${reflectorUrl}:${key}` : key

  const record: ApiKeyRecord = {
    id,
    key, // Store the auth key (without URL prefix)
    name: body.name,
    allowedDomains: body.allowedDomains,
    allowedApps: body.allowedApps,
    tier: body.tier || 'free',
    active: true,
    createdAt: Date.now(),
    version,
    reflectorUrl,
    accountId: body.accountId, // Associate with account if provided
    metadata: {
      ...body.metadata,
      createdBy: user.email,
    },
  }

  // Store by key (for validation lookups) - uses the auth key without URL prefix
  await env.APIKEYS.put(`key:${key}`, JSON.stringify(record))

  // Store by ID (for admin lookups) - with key redacted
  const { key: _, ...safeRecord } = record
  await env.APIKEYS.put(`id:${id}`, JSON.stringify({ ...safeRecord, key: '[REDACTED]' }))

  const response: CreateApiKeyResponse = {
    id,
    key: formattedKey, // Return formatted key for app config (with URL prefix for v1)
    name: body.name,
    allowedDomains: body.allowedDomains,
    tier: record.tier,
    createdAt: record.createdAt,
    version,
    reflectorUrl,
  }

  console.log(`API key created: ${id} (v${version}) by ${user.email}`)
  return json(response, 201)
}

async function getApiKey(keyId: string, env: Env): Promise<Response> {
  const record = await env.APIKEYS.get<ApiKeyRecord>(`id:${keyId}`, 'json')
  if (!record) return error('API key not found', 404)

  // Never return the actual key
  const { key: _, ...safe } = record
  return json(safe)
}

async function updateApiKey(keyId: string, request: Request, env: Env, user: AuthenticatedUser): Promise<Response> {
  // Get current record by ID
  const idRecord = await env.APIKEYS.get<ApiKeyRecord>(`id:${keyId}`, 'json')
  if (!idRecord) return error('API key not found', 404)

  // Get the full record with actual key
  // We need to find it by listing or we can store a reference
  // For now, search through key: prefix
  let fullRecord: ApiKeyRecord | null = null
  let cursor: string | undefined

  do {
    const result = await env.APIKEYS.list({ prefix: 'key:', cursor })
    for (const k of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(k.name, 'json')
      if (record && record.id === keyId) {
        fullRecord = record
        break
      }
    }
    if (fullRecord) break
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  if (!fullRecord) return error('API key data inconsistency', 500)

  const body = await request.json<UpdateApiKeyRequest>()

  // Handle accountId: null means remove, undefined means keep existing, string means set
  const newAccountId = body.accountId === null ? undefined : body.accountId !== undefined ? body.accountId : fullRecord.accountId

  // Update fields
  const updated: ApiKeyRecord = {
    ...fullRecord,
    name: body.name ?? fullRecord.name,
    allowedDomains: body.allowedDomains ?? fullRecord.allowedDomains,
    allowedApps: body.allowedApps ?? fullRecord.allowedApps,
    tier: body.tier ?? fullRecord.tier,
    active: body.active ?? fullRecord.active,
    accountId: newAccountId,
    metadata: {
      ...fullRecord.metadata,
      ...body.metadata,
      lastModifiedBy: user.email,
      lastModifiedAt: new Date().toISOString(),
    },
  }

  // Update both records
  await env.APIKEYS.put(`key:${fullRecord.key}`, JSON.stringify(updated))
  const { key: _, ...safeUpdated } = updated
  await env.APIKEYS.put(`id:${keyId}`, JSON.stringify({ ...safeUpdated, key: '[REDACTED]' }))

  console.log(`API key updated: ${keyId} by ${user.email}`)
  return json(safeUpdated)
}

async function deleteApiKey(keyId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  // Find the full record to get the actual key
  let fullRecord: ApiKeyRecord | null = null
  let cursor: string | undefined

  do {
    const result = await env.APIKEYS.list({ prefix: 'key:', cursor })
    for (const k of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(k.name, 'json')
      if (record && record.id === keyId) {
        fullRecord = record
        break
      }
    }
    if (fullRecord) break
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  if (!fullRecord) return error('API key not found', 404)

  // Delete both records
  await env.APIKEYS.delete(`key:${fullRecord.key}`)
  await env.APIKEYS.delete(`id:${keyId}`)

  console.log(`API key deleted: ${keyId} by ${user.email}`)
  return json({ deleted: true, id: keyId })
}

async function rollApiKey(keyId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  // Find the full record to get the actual key
  let fullRecord: ApiKeyRecord | null = null
  let cursor: string | undefined

  do {
    const result = await env.APIKEYS.list({ prefix: 'key:', cursor })
    for (const k of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(k.name, 'json')
      if (record && record.id === keyId) {
        fullRecord = record
        break
      }
    }
    if (fullRecord) break
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  if (!fullRecord) return error('API key not found', 404)

  // Generate new key with same version/reflector as original
  const version = fullRecord.version || 2 // Default to v2 for legacy keys
  const newKey = generateApiKey(version)

  // Format the key for user's app config (only v1 legacy keys need reflector URL prefix)
  const needsReflector = version === 1 && fullRecord.reflectorUrl
  const formattedKey = needsReflector ? `${fullRecord.reflectorUrl}:${newKey}` : newKey

  // Update record with new key
  const updated: ApiKeyRecord = {
    ...fullRecord,
    key: newKey,
    metadata: {
      ...fullRecord.metadata,
      rolledBy: user.email,
      rolledAt: new Date().toISOString(),
    },
  }

  // Delete old key record, create new one
  await env.APIKEYS.delete(`key:${fullRecord.key}`)
  await env.APIKEYS.put(`key:${newKey}`, JSON.stringify(updated))

  // Update ID record (key stays redacted)
  const { key: _, ...safeUpdated } = updated
  await env.APIKEYS.put(`id:${keyId}`, JSON.stringify({ ...safeUpdated, key: '[REDACTED]' }))

  console.log(`API key rolled: ${keyId} by ${user.email}`)
  return json({ id: keyId, key: formattedKey })
}

// ============================================================================
// MultiSynq DePIN API Compatibility Handlers
// ============================================================================
// These handlers implement the original api.multisynq.io/depin API format

/**
 * Parse URLs from DePIN format: "url1","url2","url3"
 */
function parseDepinUrls(urlsParam: string | null): string[] {
  if (!urlsParam) return []
  // Parse format: "url1","url2","url3" - quoted strings
  const matches = urlsParam.match(/"([^"]+)"/g)
  if (!matches) {
    // Try unquoted comma-separated as fallback
    return urlsParam
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
  }
  return matches.map((m) => m.slice(1, -1)) // Remove quotes
}

/**
 * Convert our domains format to DePIN urls format
 */
function toDepinUrls(domains: string[]): string[] {
  // Filter out localhost:* if present (that's dev mode)
  return domains.filter((d) => d !== 'localhost:*')
}

/**
 * Check if domains include localhost (dev mode)
 */
function isDevMode(domains: string[]): boolean {
  return domains.some((d) => d === 'localhost:*' || d === 'localhost' || d.startsWith('localhost:'))
}

/**
 * DePIN API: Create key
 * GET /depin/coders/{accountId}/create-key?location=X&name=X&dev=X&urls=X
 */
async function depinCreateKey(url: URL, env: Env, account: AccountRecord, user: AuthenticatedUser): Promise<Response> {
  const name = url.searchParams.get('name')
  if (!name) return text('Error: name parameter is required', 400)

  const urlsParam = url.searchParams.get('urls')
  const urls = parseDepinUrls(urlsParam)
  const dev = url.searchParams.get('dev') === 'true'

  // Build allowed domains list
  const allowedDomains = [...urls]
  if (dev) allowedDomains.push('localhost:*')

  // Ensure at least one domain
  if (allowedDomains.length === 0) allowedDomains.push('*') // Allow all if no urls specified

  // Generate key (v3 for Cloudflare Workers)
  const id = generateKeyId()
  const key = generateApiKey(3)

  const record: ApiKeyRecord = {
    id,
    key,
    name,
    allowedDomains,
    tier: 'free',
    active: true,
    createdAt: Date.now(),
    version: 3,
    accountId: account.id, // Associate with account
    metadata: {
      createdBy: user.email,
      createdVia: 'depin-compat-api',
    },
  }

  // Store by key and by ID
  await env.APIKEYS.put(`key:${key}`, JSON.stringify(record))
  const { key: _, ...safeRecord } = record
  await env.APIKEYS.put(`id:${id}`, JSON.stringify({ ...safeRecord, key: '[REDACTED]' }))

  console.log(`[DePIN compat] API key created: ${id} for account ${account.id} by ${user.email}`)

  // Return in DePIN format
  return json({
    key,
    name,
    urls: toDepinUrls(allowedDomains),
    devMode: dev,
  })
}

/**
 * DePIN API: Read keys
 * GET /depin/coders/{accountId}/read?details=true&what=keys,usage
 */
async function depinReadKeys(env: Env, account: AccountRecord): Promise<Response> {
  const keys: Array<{ key: string; name: string; urls: string[]; devMode: boolean }> = []
  let cursor: string | undefined

  do {
    const result = await env.APIKEYS.list({ prefix: 'key:', cursor })
    for (const k of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(k.name, 'json')
      // Only return keys owned by this account
      if (record && record.accountId === account.id) {
        keys.push({
          key: record.key,
          name: record.name,
          urls: toDepinUrls(record.allowedDomains),
          devMode: isDevMode(record.allowedDomains),
        })
      }
    }
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  // Return in DePIN format
  return json({
    keys,
    usage: {}, // Placeholder - could add actual usage stats
  })
}

/**
 * DePIN API: Update key domains
 * GET /depin/coders/{accountId}/key/{key}/update?urls=X&dev=X
 */
async function depinUpdateKey(keyValue: string, url: URL, env: Env, account: AccountRecord, user: AuthenticatedUser): Promise<Response> {
  // Find the key record
  const record = await env.APIKEYS.get<ApiKeyRecord>(`key:${keyValue}`, 'json')
  if (!record) return text('Error: Key not found', 404)

  // Verify key belongs to this account
  if (record.accountId !== account.id) return text('Error: Key not found', 404) // Don't reveal it exists but belongs to another account

  const urlsParam = url.searchParams.get('urls')
  const urls = parseDepinUrls(urlsParam)
  const devParam = url.searchParams.get('dev')
  const dev = devParam === 'true'

  // Build new allowed domains list
  const allowedDomains = [...urls]
  if (dev) allowedDomains.push('localhost:*')

  // Ensure at least one domain
  if (allowedDomains.length === 0) allowedDomains.push('*')

  // Update record
  const updated: ApiKeyRecord = {
    ...record,
    allowedDomains,
    metadata: {
      ...record.metadata,
      lastModifiedBy: user.email,
      lastModifiedAt: new Date().toISOString(),
      lastModifiedVia: 'depin-compat-api',
    },
  }

  // Save updates
  await env.APIKEYS.put(`key:${keyValue}`, JSON.stringify(updated))
  const { key: _, ...safeUpdated } = updated
  await env.APIKEYS.put(`id:${record.id}`, JSON.stringify({ ...safeUpdated, key: '[REDACTED]' }))

  console.log(`[DePIN compat] API key updated: ${record.id} by ${user.email}`)
  return text('Key updated successfully')
}

/**
 * DePIN API: Delete key
 * GET /depin/coders/{accountId}/key/{key}/delete
 */
async function depinDeleteKey(keyValue: string, env: Env, account: AccountRecord, user: AuthenticatedUser): Promise<Response> {
  // Find the key record
  const record = await env.APIKEYS.get<ApiKeyRecord>(`key:${keyValue}`, 'json')
  if (!record) return text('Error: Key not found', 404)

  // Verify key belongs to this account
  if (record.accountId !== account.id) return text('Error: Key not found', 404) // Don't reveal it exists but belongs to another account

  // Delete both records
  await env.APIKEYS.delete(`key:${keyValue}`)
  await env.APIKEYS.delete(`id:${record.id}`)

  console.log(`[DePIN compat] API key deleted: ${record.id} by ${user.email}`)
  return text('Key deleted successfully')
}

/**
 * Plain text response helper (for DePIN API compatibility)
 */
function text(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

// ============================================================================
// Session Handlers
// ============================================================================

async function listSessions(env: Env): Promise<Response> {
  const sessions: SessionRecord[] = []
  let cursor: string | undefined

  do {
    const result = await env.SESSIONS.list({ cursor })
    for (const key of result.keys) {
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (record) sessions.push(record)
    }
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  // Sort by lastSeen descending
  sessions.sort((a, b) => b.lastSeen - a.lastSeen)

  return json({ sessions, total: sessions.length })
}

async function getSession(sessionId: string, env: Env): Promise<Response> {
  const record = await env.SESSIONS.get<SessionRecord>(sessionId, 'json')
  if (!record) return error('Session not found', 404)
  return json(record)
}

async function deleteSession(sessionId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  const record = await env.SESSIONS.get<SessionRecord>(sessionId, 'json')
  if (!record) return error('Session not found', 404)

  await env.SESSIONS.delete(sessionId)
  console.log(`Session deleted: ${sessionId} by ${user.email}`)
  return json({ deleted: true, sessionId })
}

// ============================================================================
// Account Handlers (Sub-accounts for DePIN API)
// ============================================================================

async function listAccounts(env: Env, user: AuthenticatedUser): Promise<Response> {
  const accounts: Omit<AccountRecord, 'secret'>[] = []
  let cursor: string | undefined

  do {
    const result = await env.ACCOUNTS.list({ prefix: 'id:', cursor })
    for (const key of result.keys) {
      const record = await env.ACCOUNTS.get<AccountRecord>(key.name, 'json')
      if (record) {
        // Never return the secret in list
        const { secret: _, ...safe } = record
        accounts.push(safe)
      }
    }
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  return json({
    accounts,
    total: accounts.length,
    requestedBy: user.email,
  })
}

async function createAccount(request: Request, env: Env, user: AuthenticatedUser): Promise<Response> {
  const body = await request.json<CreateAccountRequest>()
  if (!body.name) return error('name is required')

  const id = generateAccountId()
  const secret = generateAccountSecret()

  const record: AccountRecord = {
    id,
    secret,
    name: body.name,
    description: body.description,
    active: true,
    createdAt: Date.now(),
    createdBy: user.email,
    metadata: body.metadata,
  }

  // Store by secret (for auth lookups)
  await env.ACCOUNTS.put(`secret:${secret}`, JSON.stringify(record))

  // Store by ID (for admin lookups)
  await env.ACCOUNTS.put(`id:${id}`, JSON.stringify(record))

  console.log(`Account created: ${id} (${body.name}) by ${user.email}`)

  // Return full record including secret (only on creation)
  return json(record, 201)
}

async function getAccount(accountId: string, env: Env): Promise<Response> {
  const record = await env.ACCOUNTS.get<AccountRecord>(`id:${accountId}`, 'json')
  if (!record) return error('Account not found', 404)

  // Never return the secret
  const { secret: _, ...safe } = record
  return json(safe)
}

async function updateAccount(accountId: string, request: Request, env: Env, user: AuthenticatedUser): Promise<Response> {
  const record = await env.ACCOUNTS.get<AccountRecord>(`id:${accountId}`, 'json')
  if (!record) return error('Account not found', 404)

  const body = await request.json<UpdateAccountRequest>()

  const updated: AccountRecord = {
    ...record,
    name: body.name ?? record.name,
    description: body.description ?? record.description,
    active: body.active ?? record.active,
    lastModified: Date.now(),
    metadata: {
      ...record.metadata,
      ...body.metadata,
    },
  }

  // Update both records
  await env.ACCOUNTS.put(`secret:${record.secret}`, JSON.stringify(updated))
  await env.ACCOUNTS.put(`id:${accountId}`, JSON.stringify(updated))

  console.log(`Account updated: ${accountId} by ${user.email}`)

  // Return without secret
  const { secret: _, ...safe } = updated
  return json(safe)
}

async function deleteAccount(accountId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  const record = await env.ACCOUNTS.get<AccountRecord>(`id:${accountId}`, 'json')
  if (!record) return error('Account not found', 404)

  // Delete both records
  await env.ACCOUNTS.delete(`secret:${record.secret}`)
  await env.ACCOUNTS.delete(`id:${accountId}`)

  console.log(`Account deleted: ${accountId} by ${user.email}`)
  return json({ deleted: true, id: accountId })
}

async function rollAccountSecret(accountId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  const record = await env.ACCOUNTS.get<AccountRecord>(`id:${accountId}`, 'json')
  if (!record) return error('Account not found', 404)

  const oldSecret = record.secret
  const newSecret = generateAccountSecret()

  const updated: AccountRecord = {
    ...record,
    secret: newSecret,
    lastModified: Date.now(),
  }

  // Delete old secret record, create new one
  await env.ACCOUNTS.delete(`secret:${oldSecret}`)
  await env.ACCOUNTS.put(`secret:${newSecret}`, JSON.stringify(updated))

  // Update ID record
  await env.ACCOUNTS.put(`id:${accountId}`, JSON.stringify(updated))

  console.log(`Account secret rolled: ${accountId} by ${user.email}`)

  // Return full record including new secret
  return json(updated)
}

// ============================================================================
// UI Handlers
// ============================================================================

async function getDashboardUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Count API keys
  let apiKeyCount = 0
  let activeKeyCount = 0
  let cursor: string | undefined
  let listResult: KVNamespaceListResult<unknown>

  do {
    listResult = await env.APIKEYS.list({ prefix: 'id:', cursor })
    for (const key of listResult.keys) {
      apiKeyCount++
      const record = await env.APIKEYS.get<ApiKeyRecord>(key.name, 'json')
      if (record?.active) activeKeyCount++
    }
    cursor = listResult.list_complete ? undefined : listResult.cursor
  } while (cursor)

  // Count sessions
  let sessionCount = 0
  let totalClients = 0
  cursor = undefined

  do {
    listResult = await env.SESSIONS.list({ cursor })
    for (const key of listResult.keys) {
      sessionCount++
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (record) totalClients += record.clientCount
    }
    cursor = listResult.list_complete ? undefined : listResult.cursor
  } while (cursor)

  return html(
    renderDashboard({
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
    })
  )
}

async function getKeysUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  const keys: Array<{
    id: string
    name: string
    allowedDomains: string[]
    tier: string
    active: boolean
    createdAt: number
    lastUsed?: number
    stats?: { totalRequests: number; totalSessions: number }
    accountId?: string
  }> = []

  let cursor: string | undefined
  do {
    const result = await env.APIKEYS.list({ prefix: 'id:', cursor })
    for (const key of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(key.name, 'json')
      if (record) {
        keys.push({
          id: record.id,
          name: record.name,
          allowedDomains: record.allowedDomains,
          tier: record.tier,
          active: record.active,
          createdAt: record.createdAt,
          lastUsed: record.lastUsed,
          stats: record.stats,
          accountId: record.accountId,
        })
      }
    }
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  // Fetch accounts for the dropdown
  const accounts: Array<{ id: string; name: string }> = []
  let accountCursor: string | undefined
  do {
    const accountResult = await env.ACCOUNTS.list({ prefix: 'id:', cursor: accountCursor })
    for (const key of accountResult.keys) {
      const record = await env.ACCOUNTS.get<AccountRecord>(key.name, 'json')
      if (record && record.active) accounts.push({ id: record.id, name: record.name })
    }
    accountCursor = accountResult.list_complete ? undefined : accountResult.cursor
  } while (accountCursor)

  // Sort accounts by name
  accounts.sort((a, b) => a.name.localeCompare(b.name))

  return html(renderKeysPage(keys, accounts, user.email, env.CLUSTER_LABEL))
}

async function getSessionsUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  const sessions: SessionRecord[] = []

  let cursor: string | undefined
  do {
    const result = await env.SESSIONS.list({ cursor })
    for (const key of result.keys) {
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (record) sessions.push(record)
    }
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  // Sort by lastSeen descending
  sessions.sort((a, b) => b.lastSeen - a.lastSeen)

  // Build a map of apiKeyId -> accountId by looking up keys
  const apiKeyAccountMap = new Map<string, { accountId?: string; accountName?: string }>()

  // Fetch all API keys to build the map
  let keyCursor: string | undefined
  do {
    const result = await env.APIKEYS.list({ prefix: 'id:', cursor: keyCursor })
    for (const key of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(key.name, 'json')
      if (record && record.accountId) apiKeyAccountMap.set(record.id, { accountId: record.accountId })
    }
    keyCursor = result.list_complete ? undefined : result.cursor
  } while (keyCursor)

  // Fetch accounts for dropdown and name lookup
  const accounts: Array<{ id: string; name: string }> = []
  const accountNameMap = new Map<string, string>()
  let accountCursor: string | undefined
  do {
    const result = await env.ACCOUNTS.list({ prefix: 'id:', cursor: accountCursor })
    for (const key of result.keys) {
      const record = await env.ACCOUNTS.get<AccountRecord>(key.name, 'json')
      if (record) {
        if (record.active) accounts.push({ id: record.id, name: record.name })
        accountNameMap.set(record.id, record.name)
      }
    }
    accountCursor = result.list_complete ? undefined : result.cursor
  } while (accountCursor)

  // Sort accounts by name
  accounts.sort((a, b) => a.name.localeCompare(b.name))

  // Enrich sessions with account info
  const enrichedSessions = sessions.map((s) => {
    const keyInfo = s.apiKeyId ? apiKeyAccountMap.get(s.apiKeyId) : undefined
    return {
      ...s,
      accountId: keyInfo?.accountId,
      accountName: keyInfo?.accountId ? accountNameMap.get(keyInfo.accountId) : undefined,
    }
  })

  return html(renderSessionsPage(enrichedSessions, accounts, user.email, env.CLUSTER_LABEL))
}

async function getAccountsUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  const accounts: AccountRecord[] = []

  let cursor: string | undefined
  do {
    const result = await env.ACCOUNTS.list({ prefix: 'id:', cursor })
    for (const key of result.keys) {
      const record = await env.ACCOUNTS.get<AccountRecord>(key.name, 'json')
      if (record) accounts.push(record)
    }
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  // Sort by createdAt descending
  accounts.sort((a, b) => b.createdAt - a.createdAt)

  return html(renderAccountsPage(accounts, user.email, env.CLUSTER_LABEL))
}

async function getSynchronizersUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Aggregate sessions by synchronizer URL directly from SESSIONS KV
  // (Manager and Registry share the same KV namespace)
  const synchronizers = new Map<
    string,
    {
      url: string
      label: string
      sessionCount: number
      clientCount: number
      lastSeen: number
      region?: string
    }
  >()

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
        // Extract label from URL (e.g., "synq.alma.dev" from "wss://synq.alma.dev")
        const label = syncUrl.replace(/^wss?:\/\//, '').replace(/\/$/, '')
        synchronizers.set(syncUrl, {
          url: syncUrl,
          label,
          sessionCount: 1,
          clientCount: session.clientCount || 0,
          lastSeen: session.lastSeen,
          region: env.CLUSTER_LABEL,
        })
      }
    }

    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  const syncList = Array.from(synchronizers.values()).sort((a, b) => b.sessionCount - a.sessionCount)
  return html(renderSynchronizersPage(syncList, user.email, env.CLUSTER_LABEL))
}

// Known synchronizer locations for map visualization
const SYNCHRONIZER_LOCATIONS: Record<string, { region: string; lat: number; lon: number }> = {
  'synq.alma.dev': { region: 'US-West', lat: 37.7749, lon: -122.4194 },
  'wss://synq.alma.dev': { region: 'US-West', lat: 37.7749, lon: -122.4194 },
  'alma-prod': { region: 'US-West', lat: 37.7749, lon: -122.4194 },
  'local-dev': { region: 'Local', lat: 40.7128, lon: -74.006 },
}

async function getMapUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Aggregate sessions by synchronizer URL directly from SESSIONS KV
  const synchronizers = new Map<
    string,
    {
      url: string
      label: string
      sessionCount: number
      clientCount: number
      lastSeen: number
      region?: string
      lat?: number
      lon?: number
    }
  >()

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
        const label = syncUrl.replace(/^wss?:\/\//, '').replace(/\/$/, '')
        // Look up known location
        const location = SYNCHRONIZER_LOCATIONS[syncUrl] || SYNCHRONIZER_LOCATIONS[label] || SYNCHRONIZER_LOCATIONS[env.CLUSTER_LABEL]
        synchronizers.set(syncUrl, {
          url: syncUrl,
          label,
          sessionCount: 1,
          clientCount: session.clientCount || 0,
          lastSeen: session.lastSeen,
          region: location?.region || env.CLUSTER_LABEL,
          lat: location?.lat,
          lon: location?.lon,
        })
      }
    }

    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  const syncList = Array.from(synchronizers.values())

  // Build GeoJSON (only include synchronizers with known coordinates)
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

  const geoJsonData = { type: 'FeatureCollection', features }
  const totals = {
    synchronizers: syncList.length,
    sessions: syncList.reduce((sum, s) => sum + s.sessionCount, 0),
    clients: syncList.reduce((sum, s) => sum + s.clientCount, 0),
  }

  return html(renderMapPage(geoJsonData, totals, user.email, env.CLUSTER_LABEL))
}
