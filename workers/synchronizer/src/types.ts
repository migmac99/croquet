// Environment bindings
export interface Env {
  SYNCHRONIZER: DurableObjectNamespace
  SNAPSHOTS: R2Bucket

  // Optional: KV for standalone mode (local dev)
  APIKEYS?: KVNamespace

  // Optional: Registry service binding (production)
  REGISTRY?: Fetcher

  // Config vars
  CLUSTER_LABEL: string
  PROTOCOL_VERSION: string
  MAX_CLIENTS_PER_SESSION: string
  SNAPSHOT_INTERVAL_MS: string
  SESSION_TIMEOUT_MS: string

  // Fallback: Registry URL for HTTP calls (when service binding not available)
  REGISTRY_URL?: string

  // Secrets
  JWT_SECRET?: string
}

// Client metadata
export interface ClientMeta {
  id: string
  userId?: string
  userIp: string
  joinedAt: number
  lastSeen: number
}

// Session state persisted in DO storage
export interface SessionState {
  id: string
  time: number
  seq: number
  createdAt: number
  lastActivity: number
  snapshotTime?: number
  snapshotSeq?: number
  snapshotUrl?: string // URL of latest snapshot
  timeline: string // Random string for seamless rejoin
  tove?: string // Encrypted session token echoed from first client's JOIN
  flags?: Record<string, unknown> // Feature flags
  tick: number // Tick interval in ms (default 50)
  delay: number // Message delay in ms (default 0)
  scale: number // Time scale factor (default 1.0)
  scaledStart: number // Synthetic start time for scaled time calculation
  rawStart: number // Raw start time (performance.now equivalent)
  lastTick: number // Time of last tick
  lastMsgTime: number // Time of last message
  messages: unknown[][] // Buffered messages since last snapshot for late-joiner catchup
  // Users event batching (matches original reflector)
  usersJoined?: string[] // Users who joined since last users event
  usersLeft?: string[] // Users who left since last users event
}

// Snapshot metadata
export interface SnapshotMeta {
  sessionId: string
  time: number
  seq: number
  size: number
  createdAt: number
}

// Message types matching Croquet protocol
export type MessageType = 'JOIN' | 'SYNC' | 'SEND' | 'RECV' | 'TICK' | 'TICKS' | 'PING' | 'PONG' | 'SNAP' | 'REQU' | 'USERS' | 'PULSE'

// Close reasons
export const CLOSE_REASONS = {
  NORMAL: [1000, 'Normal closure'],
  SESSION_FULL: [4001, 'Session full'],
  BAD_PROTOCOL: [4002, 'Protocol error'],
  AUTH_FAILED: [4003, 'Authentication failed'],
  SESSION_CLOSED: [4004, 'Session closed'],
  TIMEOUT: [4005, 'Connection timeout'],
} as const
