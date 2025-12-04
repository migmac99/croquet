export interface Env {
  // KV Namespaces
  SESSIONS: KVNamespace
  APIKEYS: KVNamespace
  ACCOUNTS: KVNamespace // Sub-accounts for DePIN API
  SYNCHRONIZERS: KVNamespace // Registered synchronizers
  SETTINGS: KVNamespace // Global settings (feature flags, etc.)

  // R2 Buckets
  SNAPSHOTS: R2Bucket // Snapshot storage (for storage stats)

  // Cloudflare Access config
  ACCESS_AUD: string // Application Audience (AUD) tag from Access

  // Config
  SYNCHRONIZER_URL: string
  CLUSTER_LABEL: string
  REGISTRY_URL?: string // URL to registry worker (for synchronizers endpoint)
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

// Re-export metrics from shared package
export { LATENCY_BUCKETS, type SessionMetrics } from '@croquet/worker-shared'
import type { SessionMetrics } from '@croquet/worker-shared'

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
  accountId?: string // Account that owns the API key used for this session
  colo?: string // Cloudflare datacenter code (e.g., 'AMS', 'FRA', 'SFO')
  metrics?: SessionMetrics // Prometheus-compatible metrics
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

/**
 * Synchronizer record stored in KV
 * Storage: `url:{url}` (base64 encoded URL as key)
 */
export interface SynchronizerRecord {
  /** Synchronizer WebSocket URL (e.g., wss://synq.alma.dev) */
  url: string

  /** Human-readable label/name */
  label: string

  /** Cloudflare datacenter code (e.g., 'SFO', 'AMS', 'FRA') */
  colo?: string

  /** Geographic region description */
  region?: string

  /** Latitude coordinate for map display */
  lat?: number

  /** Longitude coordinate for map display */
  lon?: number

  /** Is the synchronizer active/healthy? */
  active: boolean

  /** First seen timestamp */
  firstSeen: number

  /** Last heartbeat timestamp */
  lastSeen: number

  /** Current session count (from last heartbeat) */
  sessionCount: number

  /** Current client count (from last heartbeat) */
  clientCount: number

  /** Cluster label this synchronizer belongs to */
  clusterLabel?: string

  /** Optional metadata */
  metadata?: Record<string, string>
}

/**
 * Request to register/update a synchronizer
 */
export interface RegisterSynchronizerRequest {
  url: string
  label?: string
  colo?: string
  region?: string
  lat?: number
  lon?: number
  sessionCount?: number
  clientCount?: number
  clusterLabel?: string
  metadata?: Record<string, string>
}

/**
 * Global settings stored in KV
 * Storage: `setting:{key}`
 */
export interface SettingsRecord {
  /** Setting key */
  key: string

  /** Setting value */
  value: string | boolean | number

  /** Description */
  description?: string

  /** Last modified timestamp */
  lastModified: number

  /** Who last modified this setting */
  modifiedBy?: string
}

/**
 * Known settings keys
 */
export type SettingKey =
  | 'synchronizer_registration_enabled' // Enable/disable synchronizer self-registration
  | 'require_api_key' // Require API key for session creation
  | 'max_sessions_per_synchronizer' // Max sessions per synchronizer
