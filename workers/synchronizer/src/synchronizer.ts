import { DurableObject } from 'cloudflare:workers'
import type { Env, SessionState } from './types'
import { SnapshotStorage } from './storage'

const DEFAULT_TICK_MS = 20 // 20 ticks per second (default)
const SNAPSHOT_PRUNE_INTERVAL_MS = 300000 // 5 minutes
const MAX_MESSAGES = 100000 // Max messages to retain since last snapshot (matches original)
const REQU_SNAPSHOT = 60000 // Request snapshot if this many messages retained (matches original)
const INITIAL_SEQ = 0xfffffff0 >>> 0 // 4294967280 - matches original reflector island.js
const USERS_INTERVAL = 200 // Batch users events within 200ms (matches original reflector)

/** Generate a random timeline identifier for seamless rejoin support */
function generateTimeline(): string {
  return Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2)
}

/** Get current high-resolution time (equivalent to stabilizedPerformanceNow in reflector) */
function now(): number {
  return Date.now()
}

/** Get scaled time for session (advances at session's scale rate) */
function getScaledTime(state: SessionState): number {
  const sinceStart = now() - state.scaledStart
  return sinceStart * state.scale
}

/** Advance and return current integer time for session */
function advanceTime(state: SessionState): number {
  const scaledTime = Math.floor(getScaledTime(state))
  state.time = scaledTime
  return state.time
}

/**
 * Croquet Protocol Message Types (official format)
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

interface IncomingMessage {
  action: string
  args: unknown
  id?: string
  tags?: string[]
}

/**
 * Attachment stored with each WebSocket (survives hibernation)
 */
interface WSAttachment {
  clientId: string
  userId?: string
  userIp: string
  joinedAt: number
  lastSeen: number
  joined: boolean
}

/**
 * Synchronizer Durable Object with Hibernation Support
 *
 * This DO uses WebSocket hibernation to minimize costs:
 * - WebSocket connections persist even when DO is evicted from memory
 * - State is restored from storage + WebSocket attachments on wake
 * - Alarms handle periodic tasks (ticking) instead of setInterval
 *
 * Manages a single Croquet session:
 * - WebSocket connections from clients
 * - Message ordering and timestamping
 * - Snapshot coordination
 * - User presence
 */
export class Synchronizer extends DurableObject<Env> {
  private state: SessionState | null = null
  private storage: SnapshotStorage | null = null
  private lastSnapshotPrune = 0
  private pendingSnapshot: { clientId: string; time: number } | null = null
  private sessionName: string | null = null // Logical session name (from URL path)
  private usersTimer: ReturnType<typeof setTimeout> | null = null // Timer for batched users events

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // Restore state on wake from hibernation
    this.ctx.blockConcurrencyWhile(async () => {
      await this.hydrate()
    })
  }

  /**
   * Hydrate state from storage (called on wake from hibernation)
   * Handles migration of sessions created before new fields were added
   */
  private async hydrate(): Promise<void> {
    try {
      // Restore session name (logical name from URL, not DO internal ID)
      this.sessionName = (await this.ctx.storage.get<string>('sessionName')) || null

      const stored = await this.ctx.storage.get<SessionState>('state')
      if (stored) {
        this.state = stored

        // Migrate sessions created before these fields were added
        if (!this.state.messages) this.state.messages = []
        if (!this.state.scale) this.state.scale = 1.0
        if (!this.state.scaledStart) this.state.scaledStart = this.state.createdAt || now()
        if (!this.state.rawStart) this.state.rawStart = this.state.createdAt || now()
        if (this.state.lastTick === undefined) this.state.lastTick = 0
        if (this.state.lastMsgTime === undefined) this.state.lastMsgTime = 0
        if (!this.state.timeline) this.state.timeline = generateTimeline()
        if (!this.state.flags || typeof this.state.flags !== 'object') this.state.flags = {}

        if (this.env.SNAPSHOTS) this.storage = new SnapshotStorage(this.env.SNAPSHOTS, this.sessionId)
      }
    } catch (err) {
      console.error(`[${this.sessionId}] Hydrate error:`, err)
    }
  }

  /**
   * Handle incoming HTTP requests (WebSocket upgrades)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Health check
    if (url.pathname.endsWith('/health')) {
      const sockets = this.ctx.getWebSockets()
      return Response.json({
        status: 'ok',
        clients: sockets.length,
        hibernatable: true,
        state: this.state,
      })
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })

    // Capture session name from header (passed by index.ts)
    const headerSessionName = request.headers.get('X-Session-Name')
    if (headerSessionName && !this.sessionName) {
      this.sessionName = headerSessionName
      await this.ctx.storage.put('sessionName', headerSessionName)
    }

    // Check session capacity
    const maxClients = Number(this.env.MAX_CLIENTS_PER_SESSION) || 100
    const currentClients = this.ctx.getWebSockets().length
    if (currentClients >= maxClients) return new Response('Session full', { status: 503 })

    // Create WebSocket pair
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    // Extract client info from request
    const clientId = crypto.randomUUID()
    const userIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0] || 'unknown'

    // Create attachment (survives hibernation)
    const attachment: WSAttachment = {
      clientId,
      userIp,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      joined: false,
    }

    // Accept WebSocket with hibernation support
    this.ctx.acceptWebSocket(server, [clientId])

    // Store attachment with WebSocket (serialized, survives hibernation)
    server.serializeAttachment(attachment)

    console.log(`[${this.sessionId}] Client connected: ${clientId} (${currentClients + 1} total)`)

    // Ensure ticking is scheduled
    this.scheduleTick()

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Handle WebSocket messages (called by runtime, wakes DO from hibernation)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as WSAttachment
    if (!attachment) {
      console.error('No attachment found for WebSocket')
      return
    }

    attachment.lastSeen = Date.now()
    ws.serializeAttachment(attachment)

    try {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message)
      const msg = JSON.parse(data) as IncomingMessage
      await this.handleMessage(ws, attachment, msg)
    } catch (err) {
      console.error(`[${this.sessionId}] Message parse error:`, err)
    }
  }

  /**
   * Handle WebSocket close (called by runtime)
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as WSAttachment | null
    const clientId = attachment?.clientId || 'unknown'
    const userId = attachment?.userId

    console.log(`[${this.sessionId}] Client disconnected: ${clientId} (${code}: ${reason})`)

    // Queue users left event if client had joined (batched like original reflector)
    if (attachment?.joined && userId) {
      this.queueUserLeave(userId)
    }

    // Check if session is now empty
    const remaining = this.ctx.getWebSockets().length
    if (remaining === 0) {
      const timeoutMs = Number(this.env.SESSION_TIMEOUT_MS) || 300000
      await this.ctx.storage.setAlarm(Date.now() + timeoutMs)
    }
  }

  /**
   * Handle WebSocket error (called by runtime)
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as WSAttachment | null
    console.error(`[${this.sessionId}] WebSocket error for ${attachment?.clientId}:`, error)
  }

  /**
   * Process a message from a client (official Croquet protocol)
   */
  private async handleMessage(ws: WebSocket, attachment: WSAttachment, msg: IncomingMessage): Promise<void> {
    const { action, args } = msg

    switch (action) {
      case 'JOIN':
        await this.handleJoin(ws, attachment, args as Record<string, unknown>)
        break
      case 'SEND':
        this.handleSend(attachment, args as unknown[], msg.tags)
        break
      case 'PING':
        this.handlePing(ws, args as number)
        break
      case 'SNAP':
        await this.handleSnap(ws, attachment, args as Record<string, unknown>)
        break
      case 'TICKS':
        this.handleTicks(args as { tick?: number; delay?: number })
        break
      case 'PULSE':
        // Heartbeat - lastSeen already updated above
        break
      default:
        console.warn(`[${this.sessionId}] Unknown action: ${action}`)
    }
  }

  /**
   * Handle JOIN - client joining the session
   */
  private async handleJoin(ws: WebSocket, attachment: WSAttachment, args: Record<string, unknown>): Promise<void> {
    // Update attachment
    attachment.userId = args.user as string | undefined
    attachment.joined = true
    ws.serializeAttachment(attachment)

    // Extract protocol fields from JOIN args
    const tove = args.tove as string | undefined
    const flags = args.flags as Record<string, unknown> | undefined
    const ticks = args.ticks as { tick?: number; delay?: number } | undefined

    // Check if this is effectively the first client:
    // - No state exists (never had a session), OR
    // - State exists but no other clients are currently joined
    // This handles reconnection to a stale session that was hibernated
    const otherJoinedClients = this.ctx.getWebSockets().filter((s) => {
      if (s === ws) return false // Exclude self
      const att = s.deserializeAttachment() as WSAttachment
      return att?.joined
    })
    const isEffectivelyFirstClient = !this.state || otherJoinedClients.length === 0

    // Initialize session state if first client
    if (!this.state) {
      const startTime = now()
      this.state = {
        id: this.sessionId,
        time: 0,
        seq: 0,
        createdAt: startTime,
        lastActivity: startTime,
        timeline: generateTimeline(),
        tove, // Store tove from first client
        flags: flags || {}, // Store flags from first client (default to empty object)
        tick: ticks?.tick || DEFAULT_TICK_MS,
        delay: ticks?.delay || 0,
        scale: 1.0,
        scaledStart: startTime,
        rawStart: startTime,
        lastTick: 0,
        lastMsgTime: 0,
        messages: [], // Buffered messages for late-joiner catchup
      }
      await this.ctx.storage.put('state', this.state)
      if (this.env.SNAPSHOTS) this.storage = new SnapshotStorage(this.env.SNAPSHOTS, this.sessionId)
    } else {
      // Update tove/flags from joining client if not set (migration for old sessions)
      if (!this.state.tove && tove) this.state.tove = tove
      if (!this.state.flags && flags) this.state.flags = flags
    }

    // Try to load latest snapshot
    let snapshot: ArrayBuffer | null = null
    let snapshotTime = 0
    let snapshotSeq = 0

    if (this.storage) {
      try {
        const latest = await this.storage.loadLatest()
        if (latest) {
          snapshot = latest.data
          snapshotTime = latest.meta.time
          snapshotSeq = latest.meta.seq
        }
      } catch (err) {
        console.error(`[${this.sessionId}] Failed to load snapshot:`, err)
      }
    }

    // Build snapshot URL if we have one (empty string if none, matching reflector behavior)
    const snapshotUrl = snapshot ? `data:application/octet-stream;base64,${this.arrayBufferToBase64(snapshot)}` : ''

    // Without a snapshot, client must initialize fresh
    // With a snapshot, client loads snapshot and replays messages
    const clientMustInitFresh = !snapshotUrl

    if (clientMustInitFresh) {
      // No snapshot - client will init fresh
      // For late joiners: keep messages if they start at the right seq for catchup
      // For first client (or reconnect to empty session): start with empty messages
      if (isEffectivelyFirstClient) {
        this.state.messages = []
        this.state.seq = INITIAL_SEQ
        // Clear any pending users batch (stale from previous session)
        this.state.usersJoined = []
        this.state.usersLeft = []
        if (this.usersTimer) {
          clearTimeout(this.usersTimer)
          this.usersTimer = null
        }
      } else {
        // Late joiner without snapshot - check if messages can be replayed
        // If messages is empty, that's fine (fresh session, no messages yet)
        // If messages exist but start at wrong seq, reset (stale session)
        if (this.state.messages.length > 0) {
          const firstMsgSeq = (this.state.messages[0] as number[] | undefined)?.[1]
          if (firstMsgSeq !== (INITIAL_SEQ + 1) >>> 0) {
            // Messages can't be used for catchup - reset
            console.log(`[${this.sessionId}] Resetting session - messages start at ${firstMsgSeq}, expected ${(INITIAL_SEQ + 1) >>> 0}`)
            this.state.messages = []
            this.state.seq = INITIAL_SEQ
            // Generate new timeline to force all clients to reconnect fresh
            this.state.timeline = generateTimeline()
            // Clear any pending users batch (stale from previous session)
            this.state.usersJoined = []
            this.state.usersLeft = []
            if (this.usersTimer) {
              clearTimeout(this.usersTimer)
              this.usersTimer = null
            }
          }
        }
        // If messages is empty, that's fine - it's a fresh session with no messages yet
      }
    }

    // syncSeq tells client where messages start from
    // For fresh init: INITIAL_SEQ (so first msg is INITIAL_SEQ+1)
    // For snapshot: the snapshot's seq
    const syncSeq = clientMustInitFresh ? INITIAL_SEQ : snapshotSeq
    const syncTime = clientMustInitFresh ? 0 : snapshotTime

    // Send SYNC response (official Croquet protocol format)
    // Must include: url, messages, time, seq, tove, reflector, timeline, flags
    const syncArgs: Record<string, unknown> = {
      url: snapshotUrl,
      messages: this.state.messages, // Buffered messages since snapshot (for catchup)
      time: syncTime,
      seq: syncSeq,
      tove: this.state.tove,
      reflector: this.env.CLUSTER_LABEL || 'synq',
      timeline: this.state.timeline,
      flags: this.state.flags || {}, // Always include flags (even if empty)
    }

    // Add snapshot metadata if we have a snapshot
    if (snapshotUrl) {
      syncArgs.snapshotTime = snapshotTime
      syncArgs.snapshotSeq = snapshotSeq
    }

    const syncResponse = {
      id: this.sessionId,
      action: 'SYNC',
      args: syncArgs,
    }

    // Debug: log SYNC details
    console.log(
      `[${this.sessionId}] Sending SYNC: url=${snapshotUrl ? '<snapshot>' : '<none>'}, ` +
        `time=${syncTime}, seq=${syncSeq}, messages=${this.state.messages.length}, timeline=${this.state.timeline.slice(0, 8)}`
    )

    ws.send(JSON.stringify(syncResponse))

    // Queue user join for batched users event (matches original reflector)
    // The original reflector batches joins/leaves and sends them together
    if (attachment.userId) {
      this.queueUserJoin(attachment.userId)
    }

    // Ensure ticking
    this.scheduleTick()

    // Debug: log session state for troubleshooting
    console.log(
      `[${this.sessionId}] JOIN from ${attachment.clientId} (user: ${args.user}), ` +
        `isEffectivelyFirstClient=${isEffectivelyFirstClient}, clientMustInitFresh=${clientMustInitFresh}, ` +
        `seq=${this.state.seq}, messages=${this.state.messages.length}, ` +
        `syncSeq=${syncSeq}, syncTime=${syncTime}`
    )
  }

  /**
   * Send users event to all clients (matches original reflector USERS function)
   * This is broadcast to ALL clients and buffered for late-joiners
   */
  private sendUsersEvent(joined: (string | undefined)[], left: (string | undefined)[]): void {
    if (!this.state) return
    if (joined.length === 0 && left.length === 0) return

    const sockets = this.ctx.getWebSockets()
    const activeClients = sockets.filter((s) => {
      const att = s.deserializeAttachment() as WSAttachment
      return att?.joined
    })
    const active = activeClients.length
    const total = sockets.length

    if (active === 0) return // No-one to receive the message

    // Advance time
    const time = advanceTime(this.state)

    // For fresh session, seq starts at INITIAL_SEQ (set in handleJoin)
    // First message will be at INITIAL_SEQ+1 = 4294967281
    // For sessions with messages, continue from current seq
    this.state.seq = (this.state.seq + 1) >>> 0

    // Build users payload
    const payload: Record<string, unknown> = { what: 'users', active, total }
    if (joined.length > 0) payload.joined = joined.filter(Boolean)
    if (left.length > 0) payload.left = left.filter(Boolean)

    // Build message in raw format: [time, seq, payload]
    const message = [time, this.state.seq, payload]

    // Debug: log users event details
    console.log(
      `[${this.sessionId}] USERS event: time=${time}, seq=${this.state.seq}, ` +
        `active=${active}, total=${total}, joined=${JSON.stringify(joined)}, left=${JSON.stringify(left)}`
    )

    // Broadcast RECV to all active clients
    const recvMsg = {
      id: this.sessionId,
      action: 'RECV',
      args: message,
    }
    const msgStr = JSON.stringify(recvMsg)
    activeClients.forEach((ws) => ws.send(msgStr))

    // Buffer message for late-joiner catchup
    this.state.messages.push(message)
    this.state.lastMsgTime = time

    // Persist state
    this.ctx.storage.put('state', this.state)
  }

  /**
   * Queue a user join for batched users event (matches original reflector)
   * The original reflector batches joins/leaves within USERS_INTERVAL
   */
  private queueUserJoin(userId: string): void {
    if (!this.state) return
    if (!this.state.usersJoined) this.state.usersJoined = []
    if (!this.state.usersLeft) this.state.usersLeft = []

    // If user was in left array, remove from there instead of adding to joined
    const leftIdx = this.state.usersLeft.indexOf(userId)
    if (leftIdx !== -1) {
      this.state.usersLeft.splice(leftIdx, 1)
    } else {
      // Only add if not already in joined array
      if (!this.state.usersJoined.includes(userId)) {
        this.state.usersJoined.push(userId)
      }
    }
    this.scheduleUsersEvent()
  }

  /**
   * Queue a user leave for batched users event (matches original reflector)
   */
  private queueUserLeave(userId: string): void {
    if (!this.state) return
    if (!this.state.usersJoined) this.state.usersJoined = []
    if (!this.state.usersLeft) this.state.usersLeft = []

    // If user was in joined array, remove from there instead of adding to left
    const joinedIdx = this.state.usersJoined.indexOf(userId)
    if (joinedIdx !== -1) {
      this.state.usersJoined.splice(joinedIdx, 1)
    } else {
      // Only add if not already in left array
      if (!this.state.usersLeft.includes(userId)) {
        this.state.usersLeft.push(userId)
      }
    }
    this.scheduleUsersEvent()
  }

  /**
   * Schedule flushing of batched users events (matches original reflector USERS_INTERVAL)
   */
  private scheduleUsersEvent(): void {
    if (this.usersTimer) return // Already scheduled
    this.usersTimer = setTimeout(() => this.flushUsersEvent(), USERS_INTERVAL)
  }

  /**
   * Flush batched users events (called after USERS_INTERVAL)
   */
  private flushUsersEvent(): void {
    this.usersTimer = null
    if (!this.state) return

    const joined = this.state.usersJoined || []
    const left = this.state.usersLeft || []

    // Clear the batched arrays
    this.state.usersJoined = []
    this.state.usersLeft = []

    // Send the batched users event
    if (joined.length > 0 || left.length > 0) {
      this.sendUsersEvent(joined, left)
    }
  }

  /**
   * Send REQU to all clients to request a snapshot (matches original reflector)
   */
  private sendREQU(): void {
    const msg = JSON.stringify({ id: this.sessionId, action: 'REQU' })
    this.broadcast(msg)
  }

  /**
   * Send INFO to all clients (matches original reflector)
   */
  private sendINFO(args: { code: string; msg: string; options?: Record<string, unknown> }): void {
    const msg = JSON.stringify({ id: this.sessionId, action: 'INFO', args })
    this.broadcast(msg)
  }

  /**
   * Handle SEND - broadcast event to all clients
   * Matches original reflector: advanceTime, timestamp message, buffer for SYNC catchup
   */
  private handleSend(_attachment: WSAttachment, args: unknown[], _tags?: string[]): void {
    if (!this.state) return

    // Check if message buffer is full (matches original reflector)
    if (this.state.messages.length >= MAX_MESSAGES) {
      this.sendREQU()
      this.sendINFO({
        code: 'SNAPSHOT_NEEDED',
        msg: 'Cannot buffer more messages. Need snapshot.',
        options: { level: 'warning' },
      })
      return // Drop message - buffer full
    }

    // Request snapshot with increasing frequency as buffer fills (matches original)
    if (this.state.messages.length >= REQU_SNAPSHOT) {
      const headroom = MAX_MESSAGES - this.state.messages.length
      const every = Math.max(1, ((headroom / 100) | 0) * 10)
      if (this.state.messages.length % every === 0) {
        console.log(`[${this.sessionId}] Reached ${this.state.messages.length} messages, sending REQU`)
        this.sendREQU()
        // Send warning if safety buffer is less than 25%
        if (headroom < (MAX_MESSAGES - REQU_SNAPSHOT) / 4) {
          this.sendINFO({
            code: 'SNAPSHOT_NEEDED',
            msg: 'Synchronizer message buffer almost full. Need snapshot ASAP.',
            options: { level: 'warning' },
          })
        }
      }
    }

    // Advance time (matches original reflector)
    const time = advanceTime(this.state)

    // Increment seq (uint32 wrap)
    this.state.seq = (this.state.seq + 1) >>> 0
    this.state.lastActivity = now()

    // The client sends args = [time, seq, payload, ...] where time/seq are placeholders
    // We overwrite positions 0 and 1 with authoritative values (matches original reflector)
    const message = args as unknown[]
    message[0] = time
    message[1] = this.state.seq

    // Debug: log SEND message received
    console.log(`[${this.sessionId}] SEND: time=${time}, seq=${this.state.seq}, payload=${JSON.stringify(message[2]).slice(0, 100)}`)

    // Broadcast RECV to all clients (official format)
    const recvMsg = {
      id: this.sessionId,
      action: 'RECV',
      args: message,
    }
    this.broadcast(JSON.stringify(recvMsg))

    // Buffer message for late-joiner catchup (matches original: island.messages.push(message))
    this.state.messages.push(message)
    this.state.lastMsgTime = time

    // Persist state (debounced via write coalescing)
    this.ctx.storage.put('state', this.state)
  }

  /**
   * Handle PING - latency measurement
   * Note: PONG does NOT include session id (matches original reflector)
   */
  private handlePing(ws: WebSocket, timestamp: number): void {
    const pongMsg = {
      action: 'PONG',
      args: [timestamp, Date.now()],
    }
    ws.send(JSON.stringify(pongMsg))
  }

  /**
   * Handle TICKS - client requesting tick rate/scale change
   * Matches original reflector TICKS behavior
   */
  private handleTicks(args: { tick?: number; delay?: number; scale?: number }): void {
    if (!this.state) return

    const { tick, delay, scale } = args

    // Handle delay change
    if (delay !== undefined && delay > 0) this.state.delay = delay

    // Handle scale change (matches original reflector)
    if (scale !== undefined && scale > 0) {
      const MIN_SCALE = 0.001
      const MAX_SCALE = 1000
      const currentScaledTime = getScaledTime(this.state)
      const scaleToApply = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
      this.state.scale = scaleToApply
      // Maintain scaledStart at full precision so time doesn't slip
      this.state.scaledStart = now() - currentScaledTime / scaleToApply
    }

    // Handle tick rate change
    if (tick && tick > 0) {
      this.state.tick = tick
      this.scheduleTick()
    }

    // Persist updated config
    this.ctx.storage.put('state', this.state)
  }

  /**
   * Handle SNAP - snapshot operations
   * Matches original reflector SNAP behavior including message buffer management
   */
  private async handleSnap(ws: WebSocket, attachment: WSAttachment, args: Record<string, unknown>): Promise<void> {
    const action = args.action as string

    if (action === 'request') {
      if (this.pendingSnapshot) return

      this.pendingSnapshot = { clientId: attachment.clientId, time: this.state?.time || 0 }
      const snapRequest = {
        id: this.sessionId,
        action: 'SNAP',
        args: { action: 'request', time: this.state?.time, seq: this.state?.seq },
      }
      ws.send(JSON.stringify(snapRequest))
    } else if (action === 'response') {
      const { data: snapshotData, time, seq } = args
      if (!this.storage || !snapshotData || !this.state) return

      const snapshotTime = time as number
      const snapshotSeq = seq as number

      try {
        const data = this.base64ToArrayBuffer(snapshotData as string)
        await this.storage.save(data, snapshotTime, snapshotSeq)

        // Purge messages up to snapshot seq (matches original reflector behavior)
        // Keep messages with seq > snapshotSeq for late-joiner catchup
        const msgs = this.state.messages
        if (msgs.length > 0) {
          // Find first message to keep (seq after snapshot)
          const firstToKeep = msgs.findIndex((msg) => (msg[1] as number) > snapshotSeq)
          if (firstToKeep > 0) {
            // Splice out messages before snapshot
            msgs.splice(0, firstToKeep)
            console.log(`[${this.sessionId}] Purged ${firstToKeep} messages, keeping ${msgs.length}`)
          } else if (firstToKeep === -1) {
            // All messages are before or at snapshot, clear all
            msgs.length = 0
            console.log(`[${this.sessionId}] Purged all messages`)
          }
        }

        // Update snapshot metadata
        this.state.snapshotTime = snapshotTime
        this.state.snapshotSeq = snapshotSeq
        this.state.snapshotUrl = `snapshot:${snapshotSeq}` // Reference for latest

        await this.ctx.storage.put('state', this.state)

        console.log(`[${this.sessionId}] Snapshot saved: time=${snapshotTime}, seq=${snapshotSeq}, size=${data.byteLength}`)
      } catch (err) {
        console.error(`[${this.sessionId}] Failed to save snapshot:`, err)
      }

      this.pendingSnapshot = null
    }
  }

  /**
   * Schedule the next tick via alarm
   */
  private scheduleTick(): void {
    if (this.ctx.getWebSockets().length === 0) return
    const tickMs = this.state?.tick || DEFAULT_TICK_MS
    this.ctx.storage.setAlarm(Date.now() + tickMs)
  }

  /**
   * Handle alarm - used for ticking and cleanup
   * Matches original reflector TICK behavior
   */
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return

    // Tick: advance time and broadcast (official format)
    if (this.state) {
      const time = advanceTime(this.state)
      this.state.lastTick = time

      const tickMsg = {
        id: this.sessionId,
        action: 'TICK',
        args: time,
      }
      this.broadcast(JSON.stringify(tickMsg))

      // Persist state periodically
      if (this.state.seq % 100 === 0) await this.ctx.storage.put('state', this.state)
    }

    // Prune old snapshots periodically
    const currentTime = now()
    if (this.storage && currentTime - this.lastSnapshotPrune > SNAPSHOT_PRUNE_INTERVAL_MS) {
      this.storage.prune(5).catch((err) => console.error('Snapshot prune failed:', err))
      this.lastSnapshotPrune = currentTime
    }

    this.scheduleTick()
  }

  /**
   * Broadcast message to all connected clients
   */
  private broadcast(message: string, excludeClientId?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (excludeClientId) {
          const attachment = ws.deserializeAttachment() as WSAttachment | null
          if (attachment?.clientId === excludeClientId) continue
        }
        ws.send(message)
      } catch (err) {
        console.error('Broadcast send error:', err)
      }
    }
  }

  /**
   * Get session ID - uses logical session name from URL (not DO internal ID)
   * Falls back to DO ID for legacy sessions or debugging
   */
  private get sessionId(): string {
    return this.sessionName || this.ctx.id.toString()
  }

  // Utility: ArrayBuffer to Base64
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  // Utility: Base64 to ArrayBuffer
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }
}
