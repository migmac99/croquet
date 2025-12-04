/**
 * Common types shared across workers
 */

import type { SessionMetrics } from './metrics'

/**
 * Session record stored in KV (registry and manager)
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
  lat?: number // Latitude (for non-CF deployments or explicit location)
  lon?: number // Longitude (for non-CF deployments or explicit location)
  region?: string // Region label (e.g., 'US-West (San Francisco)')
  metrics?: SessionMetrics // Prometheus-compatible metrics
}

/**
 * Base API Key record - manager extends this with version/reflectorUrl
 */
export interface ApiKeyRecordBase {
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
