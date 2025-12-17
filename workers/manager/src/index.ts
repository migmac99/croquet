/**
 * Synq Manager - Admin interface for Croquet Workers
 *
 * Protected by Cloudflare Access - only authenticated users can access.
 * Manages API keys, sessions, and cluster configuration.
 */

import {
  LATENCY_BUCKETS,
  type Env,
  type AccessJWTPayload,
  type ApiKeyRecord,
  type SessionRecord,
  type CreateApiKeyRequest,
  type UpdateApiKeyRequest,
  type CreateApiKeyResponse,
  type AuthenticatedUser,
  type AccountRecord,
  type CreateAccountRequest,
  type UpdateAccountRequest,
  type SynchronizerRecord,
  type RegisterSynchronizerRequest,
  type SettingsRecord,
  type SettingKey,
} from './types'
import {
  renderDashboard,
  renderKeysPage,
  renderSessionsPage,
  renderAccountsPage,
  renderSynchronizersPage,
  renderMapPage,
  renderMetricsPage,
  renderStoragePage,
  renderSettingsPage,
  renderSessionInspectorPage,
  type SessionInspectorData,
} from './ui'

/**
 * Check if a string looks like a valid URL (has protocol)
 * Used to validate synchronizerUrl from session records since older records
 * may contain CLUSTER_LABEL instead of an actual URL
 */
function isValidUrl(url: string | undefined): boolean {
  if (!url) return false
  return /^(ws|wss|http|https):\/\//.test(url)
}

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
      if (path === '/ui/metrics') return await getMetricsUI(env, user) // Metrics UI
      if (path === '/ui/storage') return await getStorageUI(env, user) // Storage UI
      if (path === '/ui/settings') return await getSettingsUI(env, user) // Settings UI

      // Session inspector: /ui/session/{sessionId}
      const sessionInspectorMatch = path.match(/^\/ui\/session\/(.+)$/)
      if (sessionInspectorMatch) return await getSessionInspectorUI(decodeURIComponent(sessionInspectorMatch[1]), env, user)

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

      // Reveal API key (get actual key value)
      const revealMatch = path.match(/^\/keys\/([a-f0-9]+)\/reveal$/)
      if (revealMatch && request.method === 'GET') return await revealApiKey(revealMatch[1], env, user)

      // Lookup API key by value (check if exists)
      if (path === '/keys/lookup') {
        const keyValue = url.searchParams.get('key')
        if (!keyValue) return error('Missing key parameter', 400)
        return await lookupApiKey(keyValue, env)
      }

      // Metrics endpoints
      if (path === '/metrics') return await getPrometheusMetrics(env) // Prometheus format
      if (path === '/api/metrics-data') return await getMetricsData(env) // JSON for UI refresh

      // Sessions management
      if (path === '/sessions' || path === '/sessions/') {
        if (request.method === 'GET') return await listSessions(env)
      }

      // Purge all sessions
      if (path === '/sessions/purge' && request.method === 'POST') {
        return await purgeAllSessions(env, user)
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

      // Synchronizers management (registered synchronizers in KV)
      if (path === '/synchronizers' || path === '/synchronizers/') {
        if (request.method === 'GET') return await listSynchronizers(env)
        if (request.method === 'POST') return await registerSynchronizer(request, env)
      }

      // Single synchronizer operations (URL-safe base64 encoded URL as ID)
      const syncMatch = path.match(/^\/synchronizers\/(.+)$/)
      if (syncMatch) {
        const syncId = decodeURIComponent(syncMatch[1])
        if (request.method === 'GET') return await getSynchronizer(syncId, env)
        if (request.method === 'DELETE') return await deleteSynchronizer(syncId, env, user)
      }

      // Settings management
      if (path === '/settings' || path === '/settings/') {
        if (request.method === 'GET') return await listSettings(env)
      }

      // Single setting operations
      const settingMatch = path.match(/^\/settings\/([a-z_]+)$/)
      if (settingMatch) {
        const key = settingMatch[1]
        if (request.method === 'GET') return await getSetting(key, env)
        if (request.method === 'PUT') return await updateSetting(key, request, env, user)
      }

      return error('Not found', 404)
    } catch (err) {
      console.error('Request error:', err)
      return error('Internal server error', 500)
    }
  },

  /**
   * Scheduled handler for maintenance tasks
   * Runs daily to clean up old snapshots based on retention setting
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Scheduled] Running snapshot retention cleanup at ${new Date().toISOString()}`)

    // Get retention setting
    const retentionRecord = await env.SETTINGS.get<SettingsRecord>('setting:snapshot_retention_days', 'json')
    const retentionDays = (retentionRecord?.value as number) ?? 180 // Default: 6 months

    // Skip if retention is 0 (keep forever)
    if (retentionDays === 0) {
      console.log('[Scheduled] Snapshot retention set to 0 (forever) - skipping cleanup')
      return
    }

    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    console.log(`[Scheduled] Deleting snapshots older than ${cutoffDate.toISOString()} (${retentionDays} days)`)

    // Skip if R2 bucket not configured
    if (!env.SNAPSHOTS) {
      console.log('[Scheduled] SNAPSHOTS R2 bucket not configured - skipping')
      return
    }

    let deletedCount = 0
    let scannedCount = 0
    let cursor: string | undefined

    do {
      const list = await env.SNAPSHOTS.list({ cursor, limit: 500 })

      for (const obj of list.objects) {
        scannedCount++
        // Check if object is older than retention cutoff
        if (obj.uploaded && obj.uploaded < cutoffDate) {
          try {
            await env.SNAPSHOTS.delete(obj.key)
            deletedCount++
          } catch (err) {
            console.error(`[Scheduled] Failed to delete ${obj.key}:`, err)
          }
        }
      }

      cursor = list.truncated ? list.cursor : undefined
    } while (cursor)

    console.log(`[Scheduled] Cleanup complete: scanned ${scannedCount}, deleted ${deletedCount} old snapshots`)
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

/**
 * Lookup API key by its actual value (to check if it exists)
 */
async function lookupApiKey(keyValue: string, env: Env): Promise<Response> {
  const record = await env.APIKEYS.get<ApiKeyRecord>(`key:${keyValue}`, 'json')
  if (!record) {
    return json({ found: false, key: keyValue })
  }

  // Return metadata but NOT the key itself
  return json({
    found: true,
    id: record.id,
    name: record.name,
    active: record.active,
    tier: record.tier,
    allowedDomains: record.allowedDomains,
    createdAt: record.createdAt,
    lastUsed: record.lastUsed,
    accountId: record.accountId,
  })
}

/**
 * Reveal the actual key value (admin action with logging)
 */
async function revealApiKey(keyId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  // Get the ID record first to verify it exists
  const idRecord = await env.APIKEYS.get<ApiKeyRecord>(`id:${keyId}`, 'json')
  if (!idRecord) return error('API key not found', 404)

  // Find the full record with the actual key
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

  // Log this sensitive action
  console.log(`[AUDIT] API key ${keyId} revealed by ${user.email} at ${new Date().toISOString()}`)

  return json({
    id: fullRecord.id,
    key: fullRecord.key,
    name: fullRecord.name,
  })
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
  // Key format matches synchronizer: session:${sessionId}
  const record = await env.SESSIONS.get<SessionRecord>(`session:${sessionId}`, 'json')
  if (!record) return error('Session not found', 404)
  return json(record)
}

async function deleteSession(sessionId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  // Key format matches synchronizer: session:${sessionId}
  const key = `session:${sessionId}`
  const record = await env.SESSIONS.get<SessionRecord>(key, 'json')
  if (!record) return error('Session not found', 404)

  await env.SESSIONS.delete(key)
  console.log(`Session deleted: ${sessionId} by ${user.email}`)
  return json({ deleted: true, sessionId })
}

async function purgeAllSessions(env: Env, user: AuthenticatedUser): Promise<Response> {
  let deleted = 0
  let cursor: string | undefined

  do {
    const list = await env.SESSIONS.list({ cursor, limit: 1000 })

    // Delete all sessions in this batch
    for (const key of list.keys) {
      await env.SESSIONS.delete(key.name)
      deleted++
    }

    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  console.log(`All sessions purged: ${deleted} sessions deleted by ${user.email}`)
  return json({ deleted, purgedBy: user.email })
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
// Synchronizer Functions (KV-based registry)
// ============================================================================

/**
 * List all registered synchronizers from KV
 */
async function listSynchronizers(env: Env): Promise<Response> {
  const synchronizers: SynchronizerRecord[] = []
  let cursor: string | undefined

  do {
    const list = await env.SYNCHRONIZERS.list({ prefix: 'url:', cursor, limit: 1000 })
    for (const key of list.keys) {
      const record = await env.SYNCHRONIZERS.get<SynchronizerRecord>(key.name, 'json')
      if (record) synchronizers.push(record)
    }
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  // Sort by last seen (most recent first)
  synchronizers.sort((a, b) => b.lastSeen - a.lastSeen)

  return json({ synchronizers, count: synchronizers.length })
}

/**
 * Register or update a synchronizer
 * Called by synchronizers during startup/heartbeat
 */
async function registerSynchronizer(request: Request, env: Env): Promise<Response> {
  // Check if registration is enabled
  const settingEnabled = await env.SETTINGS.get<SettingsRecord>('setting:synchronizer_registration_enabled', 'json')
  if (settingEnabled && settingEnabled.value === false) {
    return error('Synchronizer registration is disabled', 403)
  }

  const body = (await request.json()) as RegisterSynchronizerRequest
  if (!body.url) return error('url is required', 400)

  // Create URL-safe key from the URL
  const key = `url:${btoa(body.url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`

  // Check for existing record
  const existing = await env.SYNCHRONIZERS.get<SynchronizerRecord>(key, 'json')

  const record: SynchronizerRecord = {
    url: body.url,
    label: body.label || body.url.replace(/^wss?:\/\//, '').replace(/\/$/, ''),
    colo: body.colo || existing?.colo,
    region: body.region || existing?.region,
    lat: body.lat ?? existing?.lat,
    lon: body.lon ?? existing?.lon,
    active: true,
    firstSeen: existing?.firstSeen || Date.now(),
    lastSeen: Date.now(),
    sessionCount: body.sessionCount ?? existing?.sessionCount ?? 0,
    clientCount: body.clientCount ?? existing?.clientCount ?? 0,
    clusterLabel: body.clusterLabel || existing?.clusterLabel,
    metadata: body.metadata || existing?.metadata,
  }

  await env.SYNCHRONIZERS.put(key, JSON.stringify(record))

  console.log(`Synchronizer registered/updated: ${body.url}`)
  return json(record, existing ? 200 : 201)
}

/**
 * Get a single synchronizer by URL
 */
async function getSynchronizer(url: string, env: Env): Promise<Response> {
  const key = `url:${btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`
  const record = await env.SYNCHRONIZERS.get<SynchronizerRecord>(key, 'json')
  if (!record) return error('Synchronizer not found', 404)
  return json(record)
}

/**
 * Delete a synchronizer registration
 */
async function deleteSynchronizer(url: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  const key = `url:${btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`
  const existing = await env.SYNCHRONIZERS.get(key)
  if (!existing) return error('Synchronizer not found', 404)

  await env.SYNCHRONIZERS.delete(key)
  console.log(`Synchronizer deleted: ${url} by ${user.email}`)
  return json({ success: true })
}

// ============================================================================
// Settings Functions
// ============================================================================

/**
 * List all settings
 */
async function listSettings(env: Env): Promise<Response> {
  const settings: SettingsRecord[] = []
  let cursor: string | undefined

  do {
    const list = await env.SETTINGS.list({ prefix: 'setting:', cursor, limit: 100 })
    for (const key of list.keys) {
      const record = await env.SETTINGS.get<SettingsRecord>(key.name, 'json')
      if (record) settings.push(record)
    }
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  return json({ settings })
}

/**
 * Get a single setting by key
 */
async function getSetting(key: string, env: Env): Promise<Response> {
  const record = await env.SETTINGS.get<SettingsRecord>(`setting:${key}`, 'json')
  if (!record) {
    // Return default value for known settings
    const defaults: Record<SettingKey, SettingsRecord> = {
      synchronizer_registration_enabled: {
        key: 'synchronizer_registration_enabled',
        value: true,
        description: 'Enable synchronizer self-registration',
        lastModified: 0,
      },
      require_api_key: { key: 'require_api_key', value: true, description: 'Require API key for session creation', lastModified: 0 },
      max_sessions_per_synchronizer: { key: 'max_sessions_per_synchronizer', value: 1000, description: 'Maximum sessions per synchronizer', lastModified: 0 },
      track_client_locations: {
        key: 'track_client_locations',
        value: false,
        description: 'Track individual client connection locations for map display',
        lastModified: 0,
      },
      snapshot_retention_days: {
        key: 'snapshot_retention_days',
        value: 180,
        description: 'Days to keep inactive session snapshots (0 = forever)',
        lastModified: 0,
      },
    }
    const defaultRecord = defaults[key as SettingKey]
    if (defaultRecord) return json(defaultRecord)
    return error('Setting not found', 404)
  }
  return json(record)
}

/**
 * Update a setting
 */
async function updateSetting(key: string, request: Request, env: Env, user: AuthenticatedUser): Promise<Response> {
  const body = (await request.json()) as { value: string | boolean | number; description?: string }
  if (body.value === undefined) return error('value is required', 400)

  const record: SettingsRecord = {
    key,
    value: body.value,
    description: body.description,
    lastModified: Date.now(),
    modifiedBy: user.email,
  }

  await env.SETTINGS.put(`setting:${key}`, JSON.stringify(record))
  console.log(`Setting updated: ${key} = ${body.value} by ${user.email}`)
  return json(record)
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

  // Build a map of apiKeyId -> { accountId, name } by looking up keys
  const apiKeyMap = new Map<string, { accountId?: string; name: string }>()

  // Fetch all API keys to build the map
  let keyCursor: string | undefined
  do {
    const result = await env.APIKEYS.list({ prefix: 'id:', cursor: keyCursor })
    for (const key of result.keys) {
      const record = await env.APIKEYS.get<ApiKeyRecord>(key.name, 'json')
      if (record) apiKeyMap.set(record.id, { accountId: record.accountId, name: record.name })
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

  // Enrich sessions with account info and API key name
  // Use accountId directly from session if available (new sessions), otherwise fall back to API key lookup (legacy)
  const enrichedSessions = sessions.map((s) => {
    const apiKeyInfo = s.apiKeyId ? apiKeyMap.get(s.apiKeyId) : undefined
    const accountId = s.accountId || apiKeyInfo?.accountId
    return {
      ...s,
      accountId,
      accountName: accountId ? accountNameMap.get(accountId) : undefined,
      apiKeyName: apiKeyInfo?.name,
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

      // Validate URL - older records may have CLUSTER_LABEL instead of actual URL
      const syncUrl = isValidUrl(session.synchronizerUrl) ? session.synchronizerUrl : env.SYNCHRONIZER_URL
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

// Cloudflare datacenter (colo) coordinates for map visualization
// See: https://www.cloudflare.com/network/
const COLO_LOCATIONS: Record<string, { region: string; lat: number; lon: number }> = {
  // North America
  SFO: { region: 'US-West (San Francisco)', lat: 37.6213, lon: -122.379 },
  LAX: { region: 'US-West (Los Angeles)', lat: 33.9425, lon: -118.408 },
  SEA: { region: 'US-West (Seattle)', lat: 47.4502, lon: -122.309 },
  PDX: { region: 'US-West (Portland)', lat: 45.5898, lon: -122.596 },
  DEN: { region: 'US-West (Denver)', lat: 39.8561, lon: -104.674 },
  PHX: { region: 'US-West (Phoenix)', lat: 33.4373, lon: -112.008 },
  DFW: { region: 'US-Central (Dallas)', lat: 32.8998, lon: -97.0403 },
  IAH: { region: 'US-Central (Houston)', lat: 29.9902, lon: -95.3368 },
  ORD: { region: 'US-Central (Chicago)', lat: 41.9742, lon: -87.9073 },
  ATL: { region: 'US-East (Atlanta)', lat: 33.6407, lon: -84.4277 },
  MIA: { region: 'US-East (Miami)', lat: 25.7959, lon: -80.287 },
  IAD: { region: 'US-East (Washington DC)', lat: 38.9531, lon: -77.4565 },
  EWR: { region: 'US-East (Newark)', lat: 40.6895, lon: -74.1745 },
  JFK: { region: 'US-East (New York)', lat: 40.6413, lon: -73.7781 },
  BOS: { region: 'US-East (Boston)', lat: 42.3656, lon: -71.0096 },
  YYZ: { region: 'Canada (Toronto)', lat: 43.6777, lon: -79.6248 },
  YVR: { region: 'Canada (Vancouver)', lat: 49.1967, lon: -123.1815 },
  YUL: { region: 'Canada (Montreal)', lat: 45.4657, lon: -73.7455 },
  // Europe
  LHR: { region: 'UK (London)', lat: 51.47, lon: -0.4543 },
  MAN: { region: 'UK (Manchester)', lat: 53.3537, lon: -2.275 },
  AMS: { region: 'Netherlands (Amsterdam)', lat: 52.3105, lon: 4.7683 },
  FRA: { region: 'Germany (Frankfurt)', lat: 50.0379, lon: 8.5622 },
  CDG: { region: 'France (Paris)', lat: 49.0097, lon: 2.5479 },
  MAD: { region: 'Spain (Madrid)', lat: 40.4936, lon: -3.5668 },
  BCN: { region: 'Spain (Barcelona)', lat: 41.2974, lon: 2.0833 },
  LIS: { region: 'Portugal (Lisbon)', lat: 38.775, lon: -9.1356 },
  MXP: { region: 'Italy (Milan)', lat: 45.6306, lon: 8.7231 },
  FCO: { region: 'Italy (Rome)', lat: 41.8003, lon: 12.2389 },
  ZRH: { region: 'Switzerland (Zurich)', lat: 47.4582, lon: 8.5555 },
  VIE: { region: 'Austria (Vienna)', lat: 48.1103, lon: 16.5697 },
  PRG: { region: 'Czech Republic (Prague)', lat: 50.1008, lon: 14.26 },
  WAW: { region: 'Poland (Warsaw)', lat: 52.1672, lon: 20.9679 },
  ARN: { region: 'Sweden (Stockholm)', lat: 59.6498, lon: 17.9238 },
  CPH: { region: 'Denmark (Copenhagen)', lat: 55.618, lon: 12.656 },
  HEL: { region: 'Finland (Helsinki)', lat: 60.3183, lon: 24.9497 },
  OSL: { region: 'Norway (Oslo)', lat: 60.1976, lon: 11.1004 },
  DUB: { region: 'Ireland (Dublin)', lat: 53.4264, lon: -6.2499 },
  BRU: { region: 'Belgium (Brussels)', lat: 50.9014, lon: 4.4844 },
  // Asia Pacific
  NRT: { region: 'Japan (Tokyo)', lat: 35.7647, lon: 140.3864 },
  KIX: { region: 'Japan (Osaka)', lat: 34.4347, lon: 135.244 },
  HKG: { region: 'Hong Kong', lat: 22.308, lon: 113.9185 },
  SIN: { region: 'Singapore', lat: 1.3644, lon: 103.9915 },
  ICN: { region: 'South Korea (Seoul)', lat: 37.4602, lon: 126.4407 },
  TPE: { region: 'Taiwan (Taipei)', lat: 25.0797, lon: 121.2342 },
  BOM: { region: 'India (Mumbai)', lat: 19.0896, lon: 72.8656 },
  DEL: { region: 'India (Delhi)', lat: 28.5562, lon: 77.1 },
  SYD: { region: 'Australia (Sydney)', lat: -33.9399, lon: 151.1753 },
  MEL: { region: 'Australia (Melbourne)', lat: -37.6733, lon: 144.8433 },
  AKL: { region: 'New Zealand (Auckland)', lat: -37.0082, lon: 174.7917 },
  // South America
  GRU: { region: 'Brazil (Sao Paulo)', lat: -23.4356, lon: -46.4731 },
  GIG: { region: 'Brazil (Rio de Janeiro)', lat: -22.8099, lon: -43.2506 },
  EZE: { region: 'Argentina (Buenos Aires)', lat: -34.8222, lon: -58.5358 },
  SCL: { region: 'Chile (Santiago)', lat: -33.393, lon: -70.7858 },
  BOG: { region: 'Colombia (Bogota)', lat: 4.7016, lon: -74.1469 },
  // Middle East / Africa
  DXB: { region: 'UAE (Dubai)', lat: 25.2532, lon: 55.3657 },
  JNB: { region: 'South Africa (Johannesburg)', lat: -26.1367, lon: 28.242 },
  CPT: { region: 'South Africa (Cape Town)', lat: -33.9715, lon: 18.6021 },
  TLV: { region: 'Israel (Tel Aviv)', lat: 32.0055, lon: 34.8854 },
}

async function getMapUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Check if client location tracking is enabled
  const trackSetting = await env.SETTINGS.get<SettingsRecord>('setting:track_client_locations', 'json')
  const trackClientLocations = trackSetting?.value === true

  // Aggregate sessions by edge location (colo) to show where clients are connecting from
  // Each colo gets a marker, with lines connecting to the DO locations
  const edgeLocations = new Map<
    string,
    {
      colo: string // Edge datacenter code
      region: string
      lat: number
      lon: number
      sessionCount: number
      clientCount: number
      lastSeen: number
      // Track DO locations for this edge (may have multiple DOs)
      doLocations: Map<string, { colo: string; lat: number; lon: number; sessionCount: number }>
    }
  >()

  // Collect individual client locations when setting is enabled
  const clientMarkers: Array<{
    clientId: string
    colo: string
    lat: number
    lon: number
    isLeader: boolean
    sessionId: string
    doColo: string
    doLat: number
    doLon: number
  }> = []

  let cursor: string | undefined
  do {
    const list = await env.SESSIONS.list({ cursor, limit: 1000 })

    for (const key of list.keys) {
      const session = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (!session) continue

      // Use colo for edge location, fallback to 'unknown'
      const edgeColo = session.colo || 'unknown'
      const edgeColoLocation = COLO_LOCATIONS[edgeColo]
      const doColo = session.doColo || edgeColo // If no doColo, assume same as edge
      const doColoLocation = COLO_LOCATIONS[doColo]

      const existing = edgeLocations.get(edgeColo)

      if (existing) {
        existing.sessionCount++
        existing.clientCount += session.clientCount || 0
        existing.lastSeen = Math.max(existing.lastSeen, session.lastSeen)
        // Track DO location
        if (doColo && doColoLocation) {
          const existingDo = existing.doLocations.get(doColo)
          if (existingDo) {
            existingDo.sessionCount++
          } else {
            existing.doLocations.set(doColo, {
              colo: doColo,
              lat: doColoLocation.lat,
              lon: doColoLocation.lon,
              sessionCount: 1,
            })
          }
        }
      } else {
        const doLocations = new Map<string, { colo: string; lat: number; lon: number; sessionCount: number }>()
        if (doColo && doColoLocation) {
          doLocations.set(doColo, { colo: doColo, lat: doColoLocation.lat, lon: doColoLocation.lon, sessionCount: 1 })
        }
        edgeLocations.set(edgeColo, {
          colo: edgeColo,
          region: session.region || edgeColoLocation?.region || edgeColo,
          lat: session.lat ?? edgeColoLocation?.lat ?? 40, // North Atlantic fallback (between NYC and Lisbon)
          lon: session.lon ?? edgeColoLocation?.lon ?? -40,
          sessionCount: 1,
          clientCount: session.clientCount || 0,
          lastSeen: session.lastSeen,
          doLocations,
        })
      }

      // Collect individual client markers when tracking is enabled
      if (trackClientLocations && session.clientLocations && doColoLocation) {
        for (const client of session.clientLocations) {
          const clientColoLoc = COLO_LOCATIONS[client.colo]
          if (clientColoLoc) {
            clientMarkers.push({
              clientId: client.clientId,
              colo: client.colo,
              lat: clientColoLoc.lat,
              lon: clientColoLoc.lon,
              isLeader: client.isLeader,
              sessionId: session.sessionId,
              doColo: doColo,
              doLat: doColoLocation.lat,
              doLon: doColoLocation.lon,
            })
          }
        }
      }
    }

    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  const locationList = Array.from(edgeLocations.values())

  // Build GeoJSON features - one per edge location, with DO connections
  const features = locationList.map((loc) => {
    // Convert DO locations map to array for JSON
    const doLocationsArray = Array.from(loc.doLocations.values())
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [loc.lon, loc.lat],
      },
      properties: {
        colo: loc.colo,
        region: loc.region,
        sessionCount: loc.sessionCount,
        clientCount: loc.clientCount,
        lastSeen: loc.lastSeen,
        // DO locations for connecting lines (array of {colo, lat, lon, sessionCount})
        doLocations: doLocationsArray,
      },
    }
  })

  const geoJsonData = {
    type: 'FeatureCollection',
    features,
    // Include client markers when tracking is enabled
    clientMarkers: trackClientLocations ? clientMarkers : undefined,
    trackingEnabled: trackClientLocations,
  }
  const totals = {
    locations: locationList.length,
    sessions: locationList.reduce((sum, s) => sum + s.sessionCount, 0),
    clients: locationList.reduce((sum, s) => sum + s.clientCount, 0),
  }

  return html(renderMapPage(geoJsonData, totals, user.email, env.CLUSTER_LABEL))
}

/**
 * Get Metrics UI page
 */
async function getMetricsUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Fetch all sessions with their metrics from SESSIONS KV
  const sessions: Array<{
    sessionId: string
    appId?: string
    clientCount: number
    metrics?: {
      messagesTotal: number
      ticksTotal: number
      latencyBuckets: number[]
      latencySum: number
      latencyCount: number
    }
  }> = []

  let cursor: string | undefined
  do {
    const list = await env.SESSIONS.list({ cursor, limit: 1000 })
    for (const key of list.keys) {
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (record) {
        sessions.push({
          sessionId: record.sessionId,
          appId: record.appId,
          clientCount: record.clientCount,
          metrics: record.metrics,
        })
      }
    }
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  return html(renderMetricsPage(sessions, user.email, env.CLUSTER_LABEL))
}

/**
 * Get Prometheus-compatible metrics (text format)
 */
async function getPrometheusMetrics(env: Env): Promise<Response> {
  // Aggregate metrics from all sessions
  const totals = {
    messagesTotal: 0,
    ticksTotal: 0,
    latencyBuckets: new Array(LATENCY_BUCKETS.length).fill(0),
    latencySum: 0,
    latencyCount: 0,
    sessionCount: 0,
    clientCount: 0,
  }

  let cursor: string | undefined
  do {
    const list = await env.SESSIONS.list({ cursor, limit: 1000 })
    for (const key of list.keys) {
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (record) {
        totals.sessionCount++
        totals.clientCount += record.clientCount || 0
        if (record.metrics) {
          totals.messagesTotal += record.metrics.messagesTotal
          totals.ticksTotal += record.metrics.ticksTotal
          totals.latencySum += record.metrics.latencySum
          totals.latencyCount += record.metrics.latencyCount
          for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
            totals.latencyBuckets[i] += record.metrics.latencyBuckets[i] || 0
          }
        }
      }
    }
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  // Build Prometheus text format
  const lines: string[] = [
    '# HELP croquet_sessions_total Total number of active sessions',
    '# TYPE croquet_sessions_total gauge',
    `croquet_sessions_total{cluster="${env.CLUSTER_LABEL}"} ${totals.sessionCount}`,
    '',
    '# HELP croquet_clients_total Total number of connected clients',
    '# TYPE croquet_clients_total gauge',
    `croquet_clients_total{cluster="${env.CLUSTER_LABEL}"} ${totals.clientCount}`,
    '',
    '# HELP croquet_messages_total Total messages processed',
    '# TYPE croquet_messages_total counter',
    `croquet_messages_total{cluster="${env.CLUSTER_LABEL}"} ${totals.messagesTotal}`,
    '',
    '# HELP croquet_ticks_total Total ticks generated',
    '# TYPE croquet_ticks_total counter',
    `croquet_ticks_total{cluster="${env.CLUSTER_LABEL}"} ${totals.ticksTotal}`,
    '',
    '# HELP croquet_latency_milliseconds Message processing latency',
    '# TYPE croquet_latency_milliseconds histogram',
  ]

  // Add histogram buckets
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    lines.push(`croquet_latency_milliseconds_bucket{cluster="${env.CLUSTER_LABEL}",le="${LATENCY_BUCKETS[i]}"} ${totals.latencyBuckets[i]}`)
  }
  lines.push(`croquet_latency_milliseconds_bucket{cluster="${env.CLUSTER_LABEL}",le="+Inf"} ${totals.latencyCount}`)
  lines.push(`croquet_latency_milliseconds_sum{cluster="${env.CLUSTER_LABEL}"} ${totals.latencySum}`)
  lines.push(`croquet_latency_milliseconds_count{cluster="${env.CLUSTER_LABEL}"} ${totals.latencyCount}`)

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/**
 * Get metrics data as JSON (for UI refresh)
 */
async function getMetricsData(env: Env): Promise<Response> {
  const sessions: Array<{
    sessionId: string
    appId?: string
    clientCount: number
    metrics?: SessionRecord['metrics']
  }> = []

  const totals = {
    messagesTotal: 0,
    ticksTotal: 0,
    latencyBuckets: new Array(LATENCY_BUCKETS.length).fill(0),
    latencySum: 0,
    latencyCount: 0,
    meanLatency: 'N/A',
  }

  let cursor: string | undefined
  do {
    const list = await env.SESSIONS.list({ cursor, limit: 1000 })
    for (const key of list.keys) {
      const record = await env.SESSIONS.get<SessionRecord>(key.name, 'json')
      if (record) {
        sessions.push({
          sessionId: record.sessionId,
          appId: record.appId,
          clientCount: record.clientCount,
          metrics: record.metrics,
        })
        if (record.metrics) {
          totals.messagesTotal += record.metrics.messagesTotal
          totals.ticksTotal += record.metrics.ticksTotal
          totals.latencySum += record.metrics.latencySum
          totals.latencyCount += record.metrics.latencyCount
          for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
            totals.latencyBuckets[i] += record.metrics.latencyBuckets[i] || 0
          }
        }
      }
    }
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)

  totals.meanLatency = totals.latencyCount > 0 ? (totals.latencySum / totals.latencyCount).toFixed(1) + 'ms' : 'N/A'

  return json({ totals, sessions })
}

/**
 * Get Storage UI page - shows KV namespace usage
 */
async function getStorageUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Helper to count keys and estimate size in a namespace
  async function scanNamespace(
    kv: KVNamespace,
    name: string,
    binding: string,
    description: string
  ): Promise<{
    namespace: { name: string; binding: string; keyCount: number; estimatedSize: number; description: string }
    recentKeys: Array<{ namespace: string; key: string; size: number; updatedAt?: number }>
  }> {
    let keyCount = 0
    let estimatedSize = 0
    const recentKeys: Array<{ namespace: string; key: string; size: number; updatedAt?: number }> = []

    let cursor: string | undefined
    do {
      const list = await kv.list({ cursor, limit: 1000 })
      for (const key of list.keys) {
        keyCount++
        // Get value to estimate size (for small datasets)
        if (keyCount <= 100) {
          const value = await kv.get(key.name)
          const size = value ? new TextEncoder().encode(value).length : 0
          estimatedSize += size
          // Keep track of recent keys (first 5 from each namespace)
          if (recentKeys.length < 5) {
            recentKeys.push({
              namespace: name,
              key: key.name,
              size,
              updatedAt:
                key.metadata && typeof key.metadata === 'object' && 'updatedAt' in key.metadata
                  ? (key.metadata as { updatedAt?: number }).updatedAt
                  : undefined,
            })
          }
        }
      }
      cursor = list.list_complete ? undefined : list.cursor
    } while (cursor)

    // Extrapolate size if we only sampled
    if (keyCount > 100) {
      estimatedSize = Math.round((estimatedSize / 100) * keyCount)
    }

    return {
      namespace: { name, binding, keyCount, estimatedSize, description },
      recentKeys,
    }
  }

  // Snapshot metrics interface
  interface SnapshotMetrics {
    totalSessions: number
    totalSnapshots: number
    totalSize: number
    avgSnapshotsPerSession: number
    avgSizePerSession: number
    avgSnapshotSize: number
  }

  // Helper to scan R2 bucket (gracefully handles missing binding)
  async function scanR2Bucket(): Promise<{
    namespace: { name: string; binding: string; keyCount: number; estimatedSize: number; description: string } | null
    recentKeys: Array<{ namespace: string; key: string; size: number; updatedAt?: number }>
    snapshotMetrics: SnapshotMetrics | null
  }> {
    // Skip if R2 bucket not configured (e.g., local dev)
    if (!env.SNAPSHOTS) {
      return { namespace: null, recentKeys: [], snapshotMetrics: null }
    }

    let objectCount = 0
    let totalSize = 0
    const recentKeys: Array<{ namespace: string; key: string; size: number; updatedAt?: number }> = []
    const sessionIds = new Set<string>()
    const sessionSizes = new Map<string, number>() // Track total size per session
    const sessionCounts = new Map<string, number>() // Track snapshot count per session

    let cursor: string | undefined
    do {
      const list = await env.SNAPSHOTS.list({ cursor, limit: 1000 })
      for (const obj of list.objects) {
        objectCount++
        totalSize += obj.size

        // Extract session ID from key: sessions/${sessionId}/snapshots/${time}-${seq}.bin
        const match = obj.key.match(/^sessions\/([^/]+)\/snapshots\//)
        if (match) {
          const sessionId = match[1]
          sessionIds.add(sessionId)
          sessionSizes.set(sessionId, (sessionSizes.get(sessionId) || 0) + obj.size)
          sessionCounts.set(sessionId, (sessionCounts.get(sessionId) || 0) + 1)
        }

        // Keep track of recent objects (first 5, sorted by upload time)
        if (recentKeys.length < 5) {
          recentKeys.push({
            namespace: 'Snapshots',
            key: obj.key,
            size: obj.size,
            updatedAt: obj.uploaded?.getTime(),
          })
        }
      }
      cursor = list.truncated ? list.cursor : undefined
    } while (cursor)

    // Calculate snapshot metrics
    const totalSessions = sessionIds.size
    const snapshotMetrics: SnapshotMetrics = {
      totalSessions,
      totalSnapshots: objectCount,
      totalSize,
      avgSnapshotsPerSession: totalSessions > 0 ? Math.round((objectCount / totalSessions) * 10) / 10 : 0,
      avgSizePerSession: totalSessions > 0 ? Math.round(totalSize / totalSessions) : 0,
      avgSnapshotSize: objectCount > 0 ? Math.round(totalSize / objectCount) : 0,
    }

    return {
      namespace: {
        name: 'Snapshots (R2)',
        binding: 'SNAPSHOTS',
        keyCount: objectCount,
        estimatedSize: totalSize,
        description: 'Session snapshots and persistent state',
      },
      recentKeys,
      snapshotMetrics,
    }
  }

  // Scan all KV namespaces and R2 bucket in parallel
  const [sessionsData, apikeysData, accountsData, synchronizersData, settingsData, snapshotsData] = await Promise.all([
    scanNamespace(env.SESSIONS, 'Sessions', 'SESSIONS', 'Active session records and state'),
    scanNamespace(env.APIKEYS, 'API Keys', 'APIKEYS', 'API key records with permissions'),
    scanNamespace(env.ACCOUNTS, 'Accounts', 'ACCOUNTS', 'Sub-accounts for DePIN API'),
    scanNamespace(env.SYNCHRONIZERS, 'Synchronizers', 'SYNCHRONIZERS', 'Registered synchronizer instances'),
    scanNamespace(env.SETTINGS, 'Settings', 'SETTINGS', 'Global configuration and feature flags'),
    scanR2Bucket(),
  ])

  const namespaces = [
    sessionsData.namespace,
    apikeysData.namespace,
    accountsData.namespace,
    synchronizersData.namespace,
    settingsData.namespace,
    snapshotsData.namespace,
  ].filter((ns): ns is NonNullable<typeof ns> => ns !== null)

  // Combine and sort recent keys by size (largest first)
  const recentKeys = [
    ...sessionsData.recentKeys,
    ...apikeysData.recentKeys,
    ...accountsData.recentKeys,
    ...synchronizersData.recentKeys,
    ...settingsData.recentKeys,
    ...snapshotsData.recentKeys,
  ]
    .sort((a, b) => b.size - a.size)
    .slice(0, 15)

  return html(renderStoragePage(namespaces, recentKeys, snapshotsData.snapshotMetrics, user.email, env.CLUSTER_LABEL))
}

/**
 * Get Settings UI page
 */
async function getSettingsUI(env: Env, user: AuthenticatedUser): Promise<Response> {
  // Helper to get setting value from KV with defaults
  async function getSettingValue<T>(key: SettingKey, defaultValue: T): Promise<T> {
    const record = await env.SETTINGS.get<SettingsRecord>(`setting:${key}`, 'json')
    if (!record) return defaultValue
    return record.value as T
  }

  // Load settings with defaults
  const settings = {
    synchronizer_registration_enabled: await getSettingValue('synchronizer_registration_enabled', true),
    require_api_key: await getSettingValue('require_api_key', true),
    max_sessions_per_synchronizer: await getSettingValue('max_sessions_per_synchronizer', 1000),
    track_client_locations: await getSettingValue('track_client_locations', false),
    snapshot_retention_days: await getSettingValue('snapshot_retention_days', 180), // Default: 6 months
  }

  return html(renderSettingsPage(settings, user.email, env.CLUSTER_LABEL))
}

/**
 * Session Inspector UI - detailed view of a single session
 */
async function getSessionInspectorUI(sessionId: string, env: Env, user: AuthenticatedUser): Promise<Response> {
  // First get session record from KV to find the synchronizer URL
  const sessionRecord = await env.SESSIONS.get<SessionRecord>(`session:${sessionId}`, 'json')

  // If no session record or invalid URL, use the default synchronizer URL
  // Older records may have CLUSTER_LABEL instead of actual URL
  const syncUrl = isValidUrl(sessionRecord?.synchronizerUrl) ? sessionRecord!.synchronizerUrl : env.SYNCHRONIZER_URL

  // Fetch detailed session info from synchronizer
  let sessionInfo: Record<string, unknown> = {}
  let snapshots: Array<{ time: number; seq: number; size: number; sizeHuman: string; createdAt: number; createdAtHuman: string }> = []

  try {
    // Convert ws/wss to http/https for API calls
    const httpUrl = syncUrl.replace(/^ws/, 'http')

    // Fetch session info and snapshots in parallel
    const [infoRes, snapshotsRes] = await Promise.all([
      fetch(`${httpUrl}/session/${encodeURIComponent(sessionId)}/info`),
      fetch(`${httpUrl}/session/${encodeURIComponent(sessionId)}/snapshots`),
    ])

    if (infoRes.ok) {
      sessionInfo = (await infoRes.json()) as Record<string, unknown>
    } else {
      // Try to parse error response (e.g., 404 for expired sessions)
      try {
        sessionInfo = (await infoRes.json()) as Record<string, unknown>
      } catch {
        sessionInfo = { status: 'expired', error: `HTTP ${infoRes.status}` }
      }
    }

    if (snapshotsRes.ok) {
      const snapshotsData = (await snapshotsRes.json()) as { snapshots?: typeof snapshots }
      snapshots = snapshotsData.snapshots || []
    }
  } catch {
    // Session likely timed out and DO was cleaned up - this is expected
    console.warn(`[mgr] Session info unavailable for ${sessionId} (session may have expired)`)
    sessionInfo = { status: 'expired' }
  }

  // Build data for the inspector page
  const data: SessionInspectorData = {
    sessionId,
    sessionName: sessionInfo.sessionName as string | undefined,
    status: (sessionInfo.status as string) || 'unknown',
    location: (sessionInfo.location as { edge?: string; durable?: string }) || {},
    timing: sessionInfo.timing as SessionInspectorData['timing'],
    snapshot: sessionInfo.snapshot as SessionInspectorData['snapshot'],
    messages: (sessionInfo.messages as SessionInspectorData['messages']) || { buffered: 0, maxBuffer: 100000 },
    clients: (sessionInfo.clients as SessionInspectorData['clients']) || { count: 0, list: [] },
    metrics: sessionInfo.metrics as SessionInspectorData['metrics'],
    tallies: (sessionInfo.tallies as number) || 0,
    flags: sessionInfo.flags as Record<string, unknown>,
    snapshots,
    synchronizerUrl: syncUrl.replace(/^ws/, 'http'),
  }

  return html(renderSessionInspectorPage(data, user.email, env.CLUSTER_LABEL))
}
