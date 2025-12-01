export interface Env {
  // KV Namespaces
  SESSIONS: KVNamespace
  APIKEYS: KVNamespace
  ACCOUNTS: KVNamespace // Sub-accounts for DePIN API

  // Cloudflare Access config
  ACCESS_AUD: string // Application Audience (AUD) tag from Access

  // Config
  SYNCHRONIZER_URL: string
  CLUSTER_LABEL: string
}

/**
 * Cloudflare Access JWT payload
 */
export interface AccessJWTPayload {
  aud: string[]
  email: string
  exp: number
  iat: number
  iss: string
  sub: string
  type: string
  identity_nonce?: string
  country?: string
}

/**
 * API Key record stored in KV
 * Key format: `key:{apiKey}` or `id:{keyId}`
 */
export interface ApiKeyRecord {
  /** Unique identifier for the key */
  id: string

  /** The actual API key (hashed for lookup-by-id) */
  key: string

  /** Human-readable name */
  name: string

  /** Allowed origin domains (glob patterns supported) */
  allowedDomains: string[]

  /** Optional: restrict to specific app IDs */
  allowedApps?: string[]

  /** Tier for rate limiting / quotas */
  tier: 'free' | 'pro' | 'enterprise' | 'unlimited'

  /** Is the key active? */
  active: boolean

  /** Creation timestamp */
  createdAt: number

  /** Last used timestamp */
  lastUsed?: number

  /** Usage stats */
  stats?: {
    totalRequests: number
    totalSessions: number
  }

  /** Optional metadata */
  metadata?: Record<string, string>

  /** API key version: 1 = deprecated Croquet.io, 2 = WebRTC/DePIN, 3 = Cloudflare Workers (WebSocket) */
  version?: 1 | 2 | 3

  /** Reflector URL (only for v1 legacy keys) */
  reflectorUrl?: string

  /** Account ID that owns this key (for DePIN API) */
  accountId?: string
}

/**
 * Session record stored in KV
 */
export interface SessionRecord {
  sessionId: string
  synchronizerUrl: string
  createdAt: number
  lastSeen: number
  clientCount: number
  appId?: string
  apiKeyId?: string
}

/**
 * Request to create a new API key
 */
export interface CreateApiKeyRequest {
  name: string
  allowedDomains: string[]
  allowedApps?: string[]
  tier?: ApiKeyRecord['tier']
  metadata?: Record<string, string>
  /** API key version: 1 = deprecated, 2 = WebRTC/DePIN, 3 = Cloudflare Workers (WebSocket). Defaults to 3 */
  version?: 1 | 2 | 3
  /** Reflector URL for v1 legacy keys only (embedded in key for old client compatibility) */
  reflectorUrl?: string
  /** Account ID that owns this key (for DePIN API) */
  accountId?: string
}

/**
 * Request to update an API key
 */
export interface UpdateApiKeyRequest {
  name?: string
  allowedDomains?: string[]
  allowedApps?: string[]
  tier?: ApiKeyRecord['tier']
  active?: boolean
  metadata?: Record<string, string>
  /** Account ID that owns this key (null to remove association) */
  accountId?: string | null
}

/**
 * Response when creating an API key
 */
export interface CreateApiKeyResponse {
  id: string
  key: string // Only returned on creation!
  name: string
  allowedDomains: string[]
  tier: string
  createdAt: number
  version: 1 | 2 | 3
  reflectorUrl?: string
}

/**
 * Authenticated user from Cloudflare Access
 */
export interface AuthenticatedUser {
  email: string
  sub: string
}

/**
 * Sub-account for DePIN API access
 * These accounts don't have login - they're managed by admins
 * Storage: `id:{accountId}` and `secret:{secret}`
 */
export interface AccountRecord {
  /** Unique account ID (used in URL path: /depin/coders/{id}/...) */
  id: string

  /** Secret token (used as Bearer token for authentication) */
  secret: string

  /** Human-readable name */
  name: string

  /** Description/notes about this account */
  description?: string

  /** Is the account active? */
  active: boolean

  /** Creation timestamp */
  createdAt: number

  /** Admin email who created this account */
  createdBy: string

  /** Last modified timestamp */
  lastModified?: number

  /** Last used timestamp */
  lastUsed?: number

  /** Optional metadata */
  metadata?: Record<string, string>
}

/**
 * Request to create a new sub-account
 */
export interface CreateAccountRequest {
  name: string
  description?: string
  metadata?: Record<string, string>
}

/**
 * Request to update a sub-account
 */
export interface UpdateAccountRequest {
  name?: string
  description?: string
  active?: boolean
  metadata?: Record<string, string>
}
