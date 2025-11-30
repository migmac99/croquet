// Environment bindings
export interface Env {
  SYNCHRONIZER: DurableObjectNamespace;
  SNAPSHOTS: R2Bucket;

  // Config vars
  CLUSTER_LABEL: string;
  PROTOCOL_VERSION: string;
  MAX_CLIENTS_PER_SESSION: string;
  SNAPSHOT_INTERVAL_MS: string;
  SESSION_TIMEOUT_MS: string;

  // Secrets
  JWT_SECRET?: string;
}

// Client metadata
export interface ClientMeta {
  id: string;
  userId?: string;
  userIp: string;
  joinedAt: number;
  lastSeen: number;
}

// Session state persisted in DO storage
export interface SessionState {
  id: string;
  time: number;
  seq: number;
  createdAt: number;
  lastActivity: number;
  snapshotTime?: number;
  snapshotSeq?: number;
}

// Snapshot metadata
export interface SnapshotMeta {
  sessionId: string;
  time: number;
  seq: number;
  size: number;
  createdAt: number;
}

// Message types matching Croquet protocol
export type MessageType =
  | 'JOIN'
  | 'SYNC'
  | 'SEND'
  | 'RECV'
  | 'TICK'
  | 'TICKS'
  | 'PING'
  | 'PONG'
  | 'SNAP'
  | 'REQU'
  | 'USERS'
  | 'PULSE';

// Close reasons
export const CLOSE_REASONS = {
  NORMAL: [1000, 'Normal closure'],
  SESSION_FULL: [4001, 'Session full'],
  BAD_PROTOCOL: [4002, 'Protocol error'],
  AUTH_FAILED: [4003, 'Authentication failed'],
  SESSION_CLOSED: [4004, 'Session closed'],
  TIMEOUT: [4005, 'Connection timeout'],
} as const;
