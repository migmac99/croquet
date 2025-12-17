// Re-export metrics from shared package
export { LATENCY_BUCKETS, type SessionMetrics } from '@croquet/worker-shared'
import type { SessionMetrics } from '@croquet/worker-shared'

export interface Env {
  // KV Namespaces
  SESSIONS: KVNamespace
  APIKEYS: KVNamespace

  // Config
  SYNCHRONIZER_URL: string
  CLUSTER_LABEL: string
  SESSION_TTL_SECONDS: string
  REQUIRE_API_KEY: string
}

/**
 * Individual client location data for map visualization
 */
export interface ClientLocation {
  clientId: string
  colo: string // Edge datacenter code (e.g., 'AMS', 'FRA', 'SFO')
  isLeader: boolean // First active client in session
}

export interface SessionRecord {
  sessionId: string
  synchronizerUrl: string
  createdAt: number
  lastSeen: number
  clientCount: number
  appId?: string
  apiKeyId?: string
  accountId?: string // Account that owns the API key used for this session
  colo?: string // Client edge datacenter code (e.g., 'AMS', 'FRA', 'SFO')
  doColo?: string // DO's actual location (detected via cdn-cgi/trace)
  lat?: number // Latitude (for non-CF deployments or explicit location)
  lon?: number // Longitude (for non-CF deployments or explicit location)
  region?: string // Region label (e.g., 'US-West (San Francisco)')
  metrics?: SessionMetrics // Prometheus-compatible metrics
  clientLocations?: ClientLocation[] // Individual client locations (when track_client_locations enabled)
}

export interface DispatchResponse {
  synchronizer: string
  sessionId: string
  token?: string
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

  /** Allowed origin domains (glob patterns supported)
   *  Including "localhost" or "localhost:*" also allows file:// URLs */
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

  /** Account ID that owns this key */
  accountId?: string
}

/**
 * API Key validation result
 */
export interface ApiKeyValidation {
  valid: boolean
  keyId?: string
  tier?: string
  accountId?: string
  error?: string
}
