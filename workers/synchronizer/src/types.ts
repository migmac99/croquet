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
  // TUTTI voting state (matches original reflector)
  // Active tallies waiting for votes
  tallies?: Record<
    string,
    {
      sendTime: number
      expecting: number
      payloads: Record<string, number> // payload hash -> vote count
      startedAt: number // For timeout tracking (DO alarm-based)
      wantsVote?: boolean
      tallyTarget?: unknown
      firstMsg?: unknown[]
    }
  >
  // Completed tallies for history (keyed by tuttiKey -> sendTime)
  completedTallies?: Record<string, number>
  // Tag records for message debouncing (matches original reflector island.tagRecords)
  tagRecords?: Record<string, number>
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
export type MessageType = 'JOIN' | 'SYNC' | 'SEND' | 'RECV' | 'TICK' | 'TICKS' | 'PING' | 'PONG' | 'SNAP' | 'REQU' | 'USERS' | 'PULSE' | 'TUTTI' | 'LOG' | 'INFO' | 'SAVE'

// Close reasons (matches original reflector REASON codes)
// Note: Clients will try to reconnect for codes < 4100
export const CLOSE_REASONS = {
  NORMAL: [1000, 'Normal closure'],
  // Codes < 4100 - client will attempt reconnect
  UNKNOWN_SESSION: [4000, 'unknown session'],
  UNRESPONSIVE: [4001, 'client unresponsive'],
  INACTIVE: [4002, 'client inactive'],
  RECONNECT: [4003, 'please reconnect'],
  // Codes >= 4100 - client will NOT attempt reconnect
  BAD_PROTOCOL: [4100, 'outdated protocol'],
  BAD_APPID: [4101, 'bad appId'],
  MALFORMED_MESSAGE: [4102, 'malformed message'],
  BAD_APIKEY: [4103, 'bad apiKey'],
  UNKNOWN_ERROR: [4109, 'unknown error'],
  DORMANT: [4110, 'dormant'],
  NO_JOIN: [4121, 'client never joined'],
  // Synchronizer-specific (not in original)
  SESSION_FULL: [4120, 'session full'],
} as const
