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

export interface SessionRecord {
  sessionId: string
  synchronizerUrl: string
  createdAt: number
  lastSeen: number
  clientCount: number
  appId?: string
  apiKeyId?: string
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
}

/**
 * API Key validation result
 */
export interface ApiKeyValidation {
  valid: boolean
  keyId?: string
  tier?: string
  error?: string
}
