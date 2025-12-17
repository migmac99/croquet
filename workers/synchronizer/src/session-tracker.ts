/**
 * Session Tracking
 *
 * Functions for tracking sessions in KV storage for manager UI visibility.
 * Also handles persistent data URL management.
 */

// ============================================================================
// Constants
// ============================================================================

/** How often to update session tracking */
export const HEARTBEAT_INTERVAL_MS = 60000 // 1 minute

/** Default TTL for session records */
export const DEFAULT_SESSION_TTL_SECONDS = 300

// ============================================================================
// Types
// ============================================================================

/** Client location info for tracking */
export interface ClientLocation {
  clientId: string
  colo: string
  isLeader: boolean
}

/** Session record stored in KV */
export interface SessionRecord {
  sessionId: string
  clientCount: number
  appId?: string
  synchronizerUrl?: string
  colo?: string
  doColo?: string
  lat?: number
  lon?: number
  region?: string
  metrics?: Record<string, number>
  clientLocations?: ClientLocation[]
  createdAt?: number
  updatedAt: number
}

/** Persistent data record stored in KV */
export interface PersistentRecord {
  url: string
  updatedAt: number
}

// ============================================================================
// Key Builders
// ============================================================================

/** Build KV key for a session */
export const buildSessionKey = (sessionId: string): string => `session:${sessionId}`

/** Build KV key for persistent data */
export const buildPersistKey = (appId: string, persistentId: string): string =>
  `persist:${appId}:${persistentId}`

// ============================================================================
// Record Builders
// ============================================================================

/** Build initial session record for tracking */
export const buildInitialSessionRecord = (opts: {
  sessionId: string
  clientCount: number
  appId?: string
  synchronizerUrl?: string
  colo?: string
  doColo?: string
  lat?: number
  lon?: number
  region?: string
  clientLocations?: ClientLocation[]
}): SessionRecord => ({
  sessionId: opts.sessionId,
  clientCount: opts.clientCount,
  appId: opts.appId,
  synchronizerUrl: opts.synchronizerUrl,
  colo: opts.colo,
  doColo: opts.doColo,
  lat: opts.lat,
  lon: opts.lon,
  region: opts.region,
  clientLocations: opts.clientLocations,
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

/** Build session record for update */
export const buildUpdateSessionRecord = (opts: {
  sessionId: string
  clientCount: number
  colo?: string
  doColo?: string
  metrics?: Record<string, number>
  clientLocations?: ClientLocation[]
}): SessionRecord => ({
  sessionId: opts.sessionId,
  clientCount: opts.clientCount,
  colo: opts.colo,
  doColo: opts.doColo,
  metrics: opts.metrics,
  clientLocations: opts.clientLocations,
  updatedAt: Date.now(),
})

/** Build persistent data record */
export const buildPersistentRecord = (url: string): PersistentRecord => ({
  url,
  updatedAt: Date.now(),
})

// ============================================================================
// Helper Functions
// ============================================================================

/** Check if enough time has passed since last update */
export const shouldUpdate = (lastUpdate: number, interval: number = HEARTBEAT_INTERVAL_MS): boolean =>
  Date.now() - lastUpdate >= interval

/** Parse TTL from env string with default */
export const parseTtl = (ttlString: string | undefined, defaultValue: number = DEFAULT_SESSION_TTL_SECONDS): number =>
  parseInt(ttlString || String(defaultValue), 10)

/**
 * Build client locations from active client data
 * Sorts by joinedAt to determine leader (first to join)
 */
export const buildClientLocations = (
  clients: Array<{ clientId: string; colo: string; joinedAt: number }>
): ClientLocation[] => {
  // Sort by joinedAt to determine leader (first to join and become active)
  const sorted = [...clients].sort((a, b) => a.joinedAt - b.joinedAt)

  return sorted.map((c, index) => ({
    clientId: c.clientId,
    colo: c.colo,
    isLeader: index === 0, // First client is leader
  }))
}

// ============================================================================
// KV Operations (wrapped for error handling)
// ============================================================================

/**
 * Track a session in KV storage
 * Returns true if successful
 */
export const trackSession = async (
  kv: KVNamespace,
  sessionId: string,
  record: SessionRecord,
  ttlSeconds: number
): Promise<boolean> => {
  try {
    await kv.put(buildSessionKey(sessionId), JSON.stringify(record), {
      expirationTtl: ttlSeconds,
    })
    return true
  } catch (err) {
    console.error(`[${sessionId}] Session tracking error:`, err)
    return false
  }
}

/**
 * Untrack a session from KV storage
 * Returns true if successful
 */
export const untrackSession = async (kv: KVNamespace, sessionId: string): Promise<boolean> => {
  try {
    await kv.delete(buildSessionKey(sessionId))
    return true
  } catch (err) {
    console.error(`[${sessionId}] Session untrack error:`, err)
    return false
  }
}

/**
 * Lookup persistent data URL from KV
 * Returns null if not found or on error
 */
export const lookupPersistentUrl = async (
  kv: KVNamespace,
  appId: string,
  persistentId: string,
  sessionId?: string
): Promise<string | null> => {
  try {
    const key = buildPersistKey(appId, persistentId)
    const data = await kv.get<PersistentRecord>(key, 'json')
    return data?.url || null
  } catch (err) {
    console.error(`[${sessionId || 'unknown'}] Persistent data lookup error:`, err)
    return null
  }
}

/**
 * Store persistent data URL in KV
 * Returns true if successful
 */
export const storePersistentUrl = async (
  kv: KVNamespace,
  appId: string,
  persistentId: string,
  url: string,
  sessionId?: string
): Promise<boolean> => {
  try {
    const key = buildPersistKey(appId, persistentId)
    await kv.put(key, JSON.stringify(buildPersistentRecord(url)))
    return true
  } catch (err) {
    console.error(`[${sessionId || 'unknown'}] Persistent data store error:`, err)
    return false
  }
}
