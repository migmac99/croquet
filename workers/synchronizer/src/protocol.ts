/**
 * Croquet Protocol Types and Message Builders
 *
 * Defines the wire protocol for client-server communication.
 *
 * Client -> Server:
 *   { action: 'JOIN', args: { version, user, ... } }
 *   { action: 'SEND', args: [...payload] }
 *   { action: 'PING', args: timestamp }
 *
 * Server -> Client:
 *   { id: sessionId, action: 'SYNC', args: { url, messages, time, seq, tove, reflector, timeline, flags } }
 *   { id: sessionId, action: 'RECV', args: [...payload] }
 *   { id: sessionId, action: 'TICK', args: timestamp }
 *   { id: sessionId, action: 'PONG', args: [clientTimestamp, serverTimestamp] }
 */

// ============================================================================
// Message Types
// ============================================================================

/** Incoming message from client */
export interface IncomingMessage {
  action: string
  args: unknown
  id?: string
  tags?: { debounce?: number; msgID?: string } // For SEND message debouncing
}

/**
 * WebSocket attachment (survives hibernation)
 *
 * State machine:
 * - joined: Client has sent JOIN message (connected to session)
 * - active: Client has received SYNC and is actively participating
 *           Only active clients are counted in USERS messages
 */
export interface WSAttachment {
  clientId: string
  userId?: string
  userIp: string
  joinedAt: number
  lastSeen: number
  joined: boolean
  active: boolean // Set true AFTER SYNC sent
  colo?: string // Edge datacenter code (e.g., 'AMS', 'FRA', 'SFO')
}

// ============================================================================
// Message Builders
// ============================================================================

/** Build a RECV message (broadcast to clients) */
export const buildRecvMessage = (sessionId: string, args: unknown[]): string => JSON.stringify({ id: sessionId, action: 'RECV', args })

/** Build a TICK message */
export const buildTickMessage = (sessionId: string, time: number): string => JSON.stringify({ id: sessionId, action: 'TICK', args: time })

/** Build a PONG message */
export const buildPongMessage = (sessionId: string, clientTime: number, serverTime: number): string =>
  JSON.stringify({ id: sessionId, action: 'PONG', args: [clientTime, serverTime] })

/** Build a SYNC message */
export const buildSyncMessage = (
  sessionId: string,
  args: {
    url?: string
    messages: unknown[][]
    time: number
    seq: number
    tove?: string
    reflector: string
    timeline: string
    flags?: Record<string, unknown>
  }
): string => JSON.stringify({ id: sessionId, action: 'SYNC', args })

/** Build a REQU message (snapshot request) */
export const buildRequMessage = (sessionId: string, time: number, seq: number): string => JSON.stringify({ id: sessionId, action: 'REQU', args: { time, seq } })

/** Build an INFO message */
export const buildInfoMessage = (sessionId: string, info: Record<string, unknown>): string => JSON.stringify({ id: sessionId, action: 'INFO', args: info })

// ============================================================================
// Attachment Helpers
// ============================================================================

/** Create initial WebSocket attachment */
export const createAttachment = (clientId: string, userIp: string, colo?: string): WSAttachment => ({
  clientId,
  userIp,
  joinedAt: Date.now(),
  lastSeen: Date.now(),
  joined: false,
  active: false,
  colo,
})

/** Update attachment to joined state */
export const markJoined = (att: WSAttachment, userId?: string): WSAttachment => ({
  ...att,
  userId,
  joined: true,
  lastSeen: Date.now(),
})

/** Update attachment to active state */
export const markActive = (att: WSAttachment): WSAttachment => ({
  ...att,
  active: true,
  lastSeen: Date.now(),
})

/** Update last seen timestamp */
export const updateLastSeen = (att: WSAttachment): WSAttachment => ({
  ...att,
  lastSeen: Date.now(),
})

/** Check if client is active and ready to receive messages */
export const isActiveClient = (att: WSAttachment | null | undefined): boolean => att?.active === true

/** Check if client has joined but not yet active */
export const isJoinedNotActive = (att: WSAttachment | null | undefined): boolean => att?.joined === true && att?.active === false
