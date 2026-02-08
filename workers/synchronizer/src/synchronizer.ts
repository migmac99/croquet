import { DurableObject } from 'cloudflare:workers'
import { CLOSE_REASONS, type Env, type SessionState, type SessionMetrics, createEmptyMetrics, recordLatency } from './types'
import { SnapshotStorage } from './storage'
import { now, generateTimeline, after, advanceTime, getRawTime, getScaledTime } from './time'
import { TALLY_INTERVAL, MAX_TALLY_AGE, MAX_COMPLETED_TALLIES } from './tally'
import { USERS_INTERVAL, INITIAL_SEQ } from './users'
import { type ClientLocation, buildClientLocations } from './session-tracker'
import { type IncomingMessage, type WSAttachment } from './protocol'
import { arrayBufferToBase64, base64ToArrayBuffer, detectColoFromTrace } from './utils'

// ============================================================================
// Session Constants
// ============================================================================

const DEFAULT_TICK_MS = 200 // 5 ticks per second (matches original reflector)
const SNAPSHOT_PRUNE_INTERVAL_MS = 300000 // 5 minutes
const MAX_MESSAGES = 100000 // Max messages to retain since last snapshot
const REQU_SNAPSHOT = 60000 // Request snapshot if this many messages retained
const MIN_SCALE = 1 / 64 // Matches original reflector (0.015625)
const MAX_SCALE = 64 // Matches original reflector
const PING_THRESHOLD_MS = 35000 // Client unresponsive if no activity
const DISCONNECT_THRESHOLD_MS = 60000 // Disconnect client if unresponsive

/**
 * Croquet Protocol (see protocol.ts for full documentation)
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
  private trackedInKV = false // Track if we've registered session in SESSIONS KV
  private trackedAppId: string | undefined // Store appId for KV updates
  private lastSessionUpdate = 0 // Track last update to SESSIONS KV
  private colo: string | null = null // Client edge datacenter code (from request.cf.colo)
  private doColo: string | null = null // DO's actual location (detected via cdn-cgi/trace)
  private doLocationDetectionStarted = false // Prevent multiple detection attempts
  private metrics: SessionMetrics = createEmptyMetrics() // Prometheus-compatible metrics (matches original reflector)

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
      // Restore client edge colo (datacenter code from request.cf.colo)
      this.colo = (await this.ctx.storage.get<string>('colo')) || null
      // Restore DO's actual location (detected via cdn-cgi/trace)
      this.doColo = (await this.ctx.storage.get<string>('doColo')) || null

      const stored = await this.ctx.storage.get<SessionState>('state')
      if (stored) {
        this.state = stored

        // Log what we loaded
        const msgCount = this.state.messages?.length || 0
        const firstSeq = msgCount > 0 ? (this.state.messages[0] as number[])?.[1] : 'none'
        const lastSeq = msgCount > 0 ? (this.state.messages[msgCount - 1] as number[])?.[1] : 'none'
        console.log(
          `[${this.sessionId}] Hydrated from storage: time=${this.state.time}, seq=${this.state.seq}, ` +
            `messages=${msgCount} (first seq: ${firstSeq}, last seq: ${lastSeq})`
        )

        // Migrate sessions created before these fields were added
        if (!this.state.messages) this.state.messages = []
        if (!this.state.scale) this.state.scale = 1.0
        if (!this.state.scaledStart) this.state.scaledStart = this.state.createdAt || now()
        if (!this.state.rawStart) this.state.rawStart = this.state.createdAt || now()
        if (this.state.lastTick === undefined) this.state.lastTick = 0
        if (this.state.lastMsgTime === undefined) this.state.lastMsgTime = 0
        if (!this.state.timeline) this.state.timeline = generateTimeline()
        if (!this.state.flags || typeof this.state.flags !== 'object') this.state.flags = {}

        // Migrate: seed snapshotHistory from existing snapshot metadata
        if (!this.state.snapshotHistory) {
          this.state.snapshotHistory = []
          if (this.state.snapshotTime && this.state.snapshotSeq) {
            this.state.snapshotHistory.push({
              time: this.state.snapshotTime,
              seq: this.state.snapshotSeq,
              size: 0,
              createdAt: this.state.lastActivity || Date.now(),
              source: this.state.snapshotUrl?.startsWith('snapshot:') ? 'direct' : 'file-server',
              url: this.state.snapshotUrl?.startsWith('snapshot:') ? undefined : this.state.snapshotUrl,
            })
          }
        }

        if (this.env.SNAPSHOTS) this.storage = new SnapshotStorage(this.env.SNAPSHOTS, this.sessionId)
      } else {
        console.log(`[${this.sessionId}] No state found in storage (fresh DO)`)
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

    // Health check (basic)
    if (url.pathname.endsWith('/health')) {
      const sockets = this.ctx.getWebSockets()
      return Response.json({
        status: 'ok',
        clients: sockets.length,
        hibernatable: true,
        colo: this.colo,
        doColo: this.doColo,
        state: this.state,
      })
    }

    // Detailed session info (for inspector/debugging)
    if (url.pathname.endsWith('/info')) {
      try {
        // Ensure storage is available for inactive session queries
        if (!this.storage && this.env.SNAPSHOTS) {
          this.storage = new SnapshotStorage(this.env.SNAPSHOTS, this.sessionId)
        }
        return Response.json(await this.getSessionInfo())
      } catch (err) {
        console.error('[sync] Error getting session info:', err)
        return Response.json({ error: 'Session not found or expired', status: 'expired' }, { status: 404 })
      }
    }

    // List snapshots for this session
    if (url.pathname.endsWith('/snapshots')) {
      try {
        // Ensure storage is available for inactive session queries
        if (!this.storage && this.env.SNAPSHOTS) {
          this.storage = new SnapshotStorage(this.env.SNAPSHOTS, this.sessionId)
        }
        return Response.json(await this.getSnapshotList())
      } catch (err) {
        console.error('[sync] Error getting snapshots:', err)
        return Response.json({ snapshots: [], error: 'Session not found or expired' }, { status: 404 })
      }
    }

    // Manual snapshot request (POST /requ) - sends REQU to all connected clients
    if (url.pathname.endsWith('/requ') && request.method === 'POST') {
      const sockets = this.ctx.getWebSockets()
      if (sockets.length === 0) {
        return Response.json({ error: 'No clients connected' }, { status: 404 })
      }
      this.sendREQU()
      return Response.json({
        sent: true,
        clients: sockets.length,
        messages: this.state?.messages.length ?? 0,
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

    // Capture Cloudflare colo (datacenter code like 'AMS', 'FRA', 'SFO')
    // The colo is passed via X-CF-Colo header from the main Worker (request.cf isn't available in DOs)
    if (!this.colo) {
      const colo = request.headers.get('X-CF-Colo')
      if (colo) {
        this.colo = colo
        await this.ctx.storage.put('colo', colo)
      }
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
    // Capture per-client colo (edge datacenter where this specific client connected)
    const clientColo = request.headers.get('X-CF-Colo') || undefined

    // Create attachment (survives hibernation)
    const attachment: WSAttachment = {
      clientId,
      userIp,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      joined: false,
      active: false, // Will be set true AFTER SYNC is sent
      colo: clientColo, // Per-client edge location
    }

    // Accept WebSocket with hibernation support
    this.ctx.acceptWebSocket(server, [clientId])

    // Store attachment with WebSocket (serialized, survives hibernation)
    server.serializeAttachment(attachment)

    console.log(`[${this.sessionId}] Client connected: ${clientId} (${currentClients + 1} total)`)

    // Ensure ticking is scheduled
    this.scheduleTick()

    // Detect DO location (fire-and-forget, only runs once)
    this.detectDoLocation()

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

    // Queue users left event only if client was ACTIVE (had received SYNC)
    // Original reflector: announceUserLeft checks client.active !== true and returns early
    if (attachment?.active && userId) this.queueUserLeave(userId)

    // Check if session is now empty
    const remaining = this.ctx.getWebSockets().length
    if (remaining === 0) {
      // Note: Can't request snapshot here (last client is already disconnecting, REQU would go to nobody).
      // Snapshots are taken during normal operation via the client's CPU-time-based mechanism.
      if (this.state && this.state.messages.length > 0) {
        console.log(
          `[${this.sessionId}] Last client disconnected - ${this.state.messages.length} messages buffered, snapshot=${this.state.snapshotUrl ? 'yes' : 'none'}`
        )
      }

      // Save message buffer to R2 for durability (in case DO is evicted)
      // This ensures zero data loss even if DO storage is cleared
      await this.saveMessageBufferToR2()

      // Untrack session from KV (removes from manager UI)
      // Fire-and-forget - don't block the close handler
      this.untrackSession()

      const timeoutMs = Number(this.env.SESSION_TIMEOUT_MS) || 300000
      await this.ctx.storage.setAlarm(Date.now() + timeoutMs)
    } else if (this.trackedInKV) {
      // Update session tracking when clients leave (but session still has clients)
      const activeCount = this.ctx.getWebSockets().filter((s) => (s.deserializeAttachment() as WSAttachment)?.active).length
      this.updateSessionTracking(activeCount)
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
        this.handlePing(ws, args)
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
      case 'TUTTI':
        this.handleTutti(args as unknown[])
        break
      case 'LOG':
        this.handleLog(attachment, args as unknown[])
        break
      case 'SAVE':
        this.handleSave(attachment, args as { persistTime: number; url: string; dissident?: unknown })
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
    const appId = args.appId as string | undefined
    const persistentId = args.persistentId as string | undefined

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
        seq: INITIAL_SEQ, // Must match original reflector - first message will be INITIAL_SEQ+1
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
        appId, // Store appId for persistent data (matches original reflector)
        persistentId, // Store persistentId for persistent data (matches original reflector)
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

    // If no snapshot but we have state in storage, try loading message buffer from R2
    // This handles the case where DO was evicted but message buffer was saved
    if (!snapshot && this.state) {
      const messageBuffer = await this.loadMessageBufferFromR2()
      if (messageBuffer) {
        // Restore state from message buffer
        this.state.time = messageBuffer.time
        this.state.seq = messageBuffer.seq
        this.state.messages = messageBuffer.messages
        this.state.timeline = messageBuffer.timeline
        this.state.scaledStart = now() - messageBuffer.time / this.state.scale
        if (messageBuffer.snapshotTime) this.state.snapshotTime = messageBuffer.snapshotTime
        if (messageBuffer.snapshotSeq) this.state.snapshotSeq = messageBuffer.snapshotSeq

        console.log(
          `[${this.sessionId}] Restored from R2 message buffer: time=${messageBuffer.time}, seq=${messageBuffer.seq}, messages=${messageBuffer.messages.length}`
        )
      }
    }

    // Build snapshot URL - prefer R2 snapshot, fall back to stored file server URL
    let snapshotUrl = ''
    if (snapshot) {
      snapshotUrl = `data:application/octet-stream;base64,${arrayBufferToBase64(snapshot)}`
    } else if (this.state.snapshotUrl && !this.state.snapshotUrl.startsWith('snapshot:')) {
      // We have a file server URL from a client SNAP announcement (standard Croquet protocol)
      snapshotUrl = this.state.snapshotUrl
      snapshotTime = this.state.snapshotTime || 0
      snapshotSeq = this.state.snapshotSeq || 0
      console.log(`[${this.sessionId}] Using stored snapshot URL: time=${snapshotTime}, seq=${snapshotSeq}`)
    }

    // If no snapshot and persistentId provided, lookup persistent URL from registry
    // Note: persistentUrl is set ONCE at session start, never updated by SAVE (matches original reflector)
    if (!snapshot && this.state.persistentId && this.state.appId && !this.state.persistentUrl) {
      try {
        const persistedData = await this.lookupPersistentUrl(this.state.appId, this.state.persistentId)
        if (persistedData) {
          this.state.persistentUrl = persistedData
          console.log(`[${this.sessionId}] Loaded persistent data URL: ${persistedData}`)
        }
      } catch (err) {
        console.error(`[${this.sessionId}] Failed to lookup persistent data:`, err)
      }
    }

    // Without a snapshot, client must initialize fresh
    // With a snapshot, client loads snapshot and replays messages
    const clientMustInitFresh = !snapshotUrl

    // When first client joins after hibernation, restore state from snapshot if needed
    if (isEffectivelyFirstClient && !clientMustInitFresh && this.state.time === 0 && this.state.seq === INITIAL_SEQ) {
      // CRITICAL: Restore state from snapshot to continue correctly after hibernation
      // Without this, time/seq would stay at 0/INITIAL_SEQ and new TICKs
      // would have wrong timestamps, causing "Expected message #X got #Y" errors
      console.log(`[${this.sessionId}] Restoring state from snapshot after hibernation: time=${snapshotTime}, seq=${snapshotSeq}`)
      this.state.time = snapshotTime
      this.state.seq = snapshotSeq
      this.state.scaledStart = now() - snapshotTime / this.state.scale
      this.state.snapshotTime = snapshotTime
      this.state.snapshotSeq = snapshotSeq
      this.state.snapshotUrl = `snapshot:${snapshotSeq}`
    }

    // NEVER clear message buffer based on time - messages are needed for late-joiner catchup
    // and reconnection. Snapshot purging (in handleSnap) handles cleanup naturally.
    // Only reset seq/time if truly starting fresh (no snapshot at all)
    if (isEffectivelyFirstClient && clientMustInitFresh && this.state.seq === INITIAL_SEQ) {
      console.log(`[${this.sessionId}] First client - fresh start`)
    } else if (isEffectivelyFirstClient) {
      console.log(`[${this.sessionId}] First client rejoining - keeping ${this.state.messages.length} buffered messages`)
    } else if (clientMustInitFresh) {
      // Late joiner without snapshot - just log for visibility
      // Never clear messages - they may be needed for late-joiner catchup
      if (this.state.messages.length > 0) {
        const firstMsgSeq = (this.state.messages[0] as number[] | undefined)?.[1]
        console.log(
          `[${this.sessionId}] Late joiner without snapshot - ${this.state.messages.length} buffered messages ` +
            `(first seq: ${firstMsgSeq}, current seq: ${this.state.seq})`
        )
      }
    }

    // syncTime is the time at the snapshot (or 0 for fresh init)
    const syncTime = clientMustInitFresh ? 0 : snapshotTime

    // Validate message buffer consistency with snapshot
    // This catches corruption from hibernation/wake or stale state
    let stateWasCorrected = false
    if (!clientMustInitFresh && this.state.messages.length > 0) {
      const firstMsgSeq = (this.state.messages[0] as number[])?.[1]
      const lastMsgSeq = (this.state.messages[this.state.messages.length - 1] as number[])?.[1]

      // Log warnings about inconsistencies but NEVER clear messages
      if (firstMsgSeq !== undefined && !after(snapshotSeq, firstMsgSeq)) {
        console.warn(
          `[${this.sessionId}] Message buffer note: first msg seq=${firstMsgSeq} not after snapshot seq=${snapshotSeq}. Keeping messages for catchup.`
        )
      }
      // Current seq should match or be after last message seq - fix if needed
      if (lastMsgSeq !== undefined && after(this.state.seq, lastMsgSeq)) {
        console.warn(`[${this.sessionId}] Seq inconsistent: state.seq=${this.state.seq} is before last msg seq=${lastMsgSeq}. Correcting to ${lastMsgSeq}.`)
        this.state.seq = lastMsgSeq
        stateWasCorrected = true
      }
    }
    // Persist corrections to prevent repeated issues
    if (stateWasCorrected) {
      this.ctx.storage.put('state', this.state)
    }

    // Send SYNC response (official Croquet protocol format)
    // Must include: url, messages, time, seq, tove, reflector, timeline, flags
    //
    // CRITICAL: seq MUST be the CURRENT this.state.seq (matches original reflector: island.seq)
    // NOT snapshotSeq or INITIAL_SEQ! The client uses this to know what seq to expect next.
    // After replaying buffered messages, client expects seq+1 for new messages.
    const syncArgs: Record<string, unknown> = {
      url: snapshotUrl,
      messages: this.state.messages, // Buffered messages since snapshot (for catchup)
      time: syncTime,
      seq: this.state.seq, // MUST be current seq (matches original reflector)
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
    // If no snapshot but persistentUrl exists, use it (matches original reflector)
    else if (this.state.persistentUrl) {
      syncArgs.url = this.state.persistentUrl
      syncArgs.persisted = true
    }

    const syncResponse = {
      id: this.sessionId,
      action: 'SYNC',
      args: syncArgs,
    }

    // Debug: log SYNC details with message buffer info
    const msgCount = this.state.messages.length
    const firstMsgSeq = msgCount > 0 ? (this.state.messages[0] as number[])?.[1] : 'none'
    const lastMsgSeq = msgCount > 0 ? (this.state.messages[msgCount - 1] as number[])?.[1] : 'none'
    console.log(
      `[${this.sessionId}] Sending SYNC: url=${snapshotUrl ? '<snapshot>' : '<none>'}, ` +
        `time=${syncTime}, seq=${this.state.seq}, messages=${msgCount} ` +
        `(first seq: ${firstMsgSeq}, last seq: ${lastMsgSeq}), timeline=${this.state.timeline.slice(0, 8)}`
    )

    ws.send(JSON.stringify(syncResponse))

    // Mark client as active AFTER SYNC is sent (matches original reflector)
    // In original: announceUserJoined() sets client.active = true after SYNC
    // This is critical for correct view count in USERS messages
    attachment.active = true
    ws.serializeAttachment(attachment)

    // Queue user join for batched users event (matches original reflector)
    // The original reflector batches joins/leaves and sends them together
    if (attachment.userId) this.queueUserJoin(attachment.userId)

    // Ensure ticking
    this.scheduleTick()

    // Track session in KV for manager UI visibility
    // This is fire-and-forget - don't block the JOIN response
    const activeCount = this.ctx.getWebSockets().filter((s) => (s.deserializeAttachment() as WSAttachment)?.active).length
    if (isEffectivelyFirstClient) this.trackSession(activeCount || 1, args.appId as string | undefined)
    else if (this.trackedInKV) this.updateSessionTracking(activeCount + 1) // Update tracking when additional clients join, +1 because this client just became active

    // Debug: log session state for troubleshooting
    console.log(
      `[${this.sessionId}] JOIN from ${attachment.clientId} (user: ${args.user}), ` +
        `isEffectivelyFirstClient=${isEffectivelyFirstClient}, clientMustInitFresh=${clientMustInitFresh}, ` +
        `seq=${this.state.seq}, messages=${this.state.messages.length}, syncTime=${syncTime}`
    )

    // Don't request initial snapshot immediately - let Croquet's natural snapshot
    // mechanism handle it based on CPU time. Requesting too early causes snapshots
    // before users create any meaningful state, leading to state loss on refresh.
  }

  /**
   * Send users event to all clients (matches original reflector USERS function)
   * This is broadcast to ALL clients and buffered for late-joiners
   *
   * CRITICAL: Count only clients where active === true (not just joined)
   * Original reflector: [...clients].filter(each => each.active)
   * A client in the set but not active is between JOIN and SYNC
   */
  private async sendUsersEvent(joined: (string | undefined)[], left: (string | undefined)[]): Promise<void> {
    if (!this.state) return
    if (joined.length === 0 && left.length === 0) return

    const sockets = this.ctx.getWebSockets()
    // Count only ACTIVE clients (have received SYNC) - matches original reflector
    // In original reflector: activeClients = [...clients].filter(each => each.active)
    const activeClients = sockets.filter((s) => {
      const att = s.deserializeAttachment() as WSAttachment
      return att?.active === true // Only count clients that have received SYNC
    })
    const active = activeClients.length
    // In original reflector: total = clients.size (clients added to Set after SYNC)
    // Clients in Set but not yet active are briefly between SYNC and announceUserJoined
    // For consistency, use active count (original reflector's clients.size ≈ active count)
    const total = active
    if (active === 0) return // No-one to receive the message

    // Advance time
    const time = advanceTime(this.state, 'USERS')

    // For fresh session, seq starts at INITIAL_SEQ (set in handleJoin)
    // First message will be at INITIAL_SEQ+1 = 4294967281
    // For sessions with messages, continue from current seq
    this.state.seq = (this.state.seq + 1) >>> 0

    // Build users payload
    const payload: Record<string, unknown> = { what: 'users', active, total }
    if (joined.length > 0) payload.joined = joined.filter(Boolean)
    if (left.length > 0) payload.left = left.filter(Boolean)

    // Add _size property for accounting (matches original reflector)
    payload._size = JSON.stringify(payload).length

    // Build message in raw format: [time, seq, payload]
    const message = [time, this.state.seq, payload]

    // Debug: log users event details
    console.log(
      `[${this.sessionId}] USERS event: time=${time}, seq=${this.state.seq}, ` +
        `active=${active}, total=${total}, joined=${JSON.stringify(joined)}, left=${JSON.stringify(left)}`
    )

    // Broadcast RECV to all active clients
    const recvMsg = { id: this.sessionId, action: 'RECV', args: message }
    const msgStr = JSON.stringify(recvMsg)
    activeClients.forEach((ws) => ws.send(msgStr))

    // Buffer message for late-joiner catchup
    this.state.messages.push(message)
    this.state.lastMsgTime = time
    this.state.lastActivity = now() // Track activity for warm/cold session detection

    // Persist state - await to ensure it completes before hibernation
    await this.ctx.storage.put('state', this.state)
    console.log(`[${this.sessionId}] USERS event persisted: seq=${this.state.seq}, buffer size=${this.state.messages.length}`)
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
    if (leftIdx !== -1) this.state.usersLeft.splice(leftIdx, 1)
    else if (!this.state.usersJoined.includes(userId)) this.state.usersJoined.push(userId) // Only add if not already in joined array
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
    if (joinedIdx !== -1) this.state.usersJoined.splice(joinedIdx, 1)
    else if (!this.state.usersLeft.includes(userId)) this.state.usersLeft.push(userId) // Only add if not already in left array
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
  private async flushUsersEvent(): Promise<void> {
    this.usersTimer = null
    if (!this.state) return

    const joined = this.state.usersJoined || []
    const left = this.state.usersLeft || []

    // Clear the batched arrays
    this.state.usersJoined = []
    this.state.usersLeft = []

    // Send the batched users event
    if (joined.length > 0 || left.length > 0) await this.sendUsersEvent(joined, left)
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
  private async handleSend(_attachment: WSAttachment, args: unknown[], tags?: { debounce?: number; msgID?: string }): Promise<void> {
    if (!this.state) return

    // Debounce support (matches original reflector SEND_TAGGED)
    // Tag pattern example: { debounce: 1000, msgID: "pollForSnapshot" }
    if (tags?.debounce && tags.msgID) {
      const wallClockNow = Date.now() // debounce uses wall-clock time
      if (!this.state.tagRecords) this.state.tagRecords = {}
      const lastSent = this.state.tagRecords[tags.msgID]
      if (lastSent && wallClockNow - lastSent <= tags.debounce) {
        // Suppress message - within debounce window
        console.log(`[${this.sessionId}] Debounce suppressed: msgID=${tags.msgID}`)
        return
      }
      // Record this send time
      this.state.tagRecords[tags.msgID] = wallClockNow
    }

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

    // CRITICAL: Extract latency BEFORE any modifications (matches original reflector)
    // Original reflector extracts latency in case 'SEND' BEFORE calling SEND() which modifies the message
    const latency = args[args.length - 1]

    // Advance time (matches original reflector)
    const time = advanceTime(this.state, 'SEND')

    // Increment seq (uint32 wrap)
    this.state.seq = (this.state.seq + 1) >>> 0
    this.state.lastActivity = now()

    // The client sends args = [time, seq, payload, ...] where time/seq are placeholders
    // We overwrite positions 0 and 1 with authoritative values (matches original reflector)
    const message = args as unknown[]
    message[0] = time
    message[1] = this.state.seq

    // Add _size property to non-string payloads for accounting (matches original reflector)
    // See payloadSizeForAccounting() - ensures synchronizer and clients see same byte tally
    if (typeof message[2] !== 'string' && message[2] != null) {
      ;(message[2] as Record<string, unknown>)._size = JSON.stringify(message[2]).length
    }

    // If rawtime flag is set, overwrite last element with raw time (matches original reflector)
    // This MUST happen AFTER extracting latency above
    if (this.state.flags?.rawtime) message[message.length - 1] = getRawTime(this.state)

    // Debug: log SEND message received
    console.log(`[${this.sessionId}] SEND: time=${time}, seq=${this.state.seq}, payload=${JSON.stringify(message[2]).slice(0, 100)}`)

    // Broadcast RECV to all clients (official format)
    const recvMsg = { id: this.sessionId, action: 'RECV', args: message }
    this.broadcast(JSON.stringify(recvMsg))

    // Buffer message for late-joiner catchup (matches original: island.messages.push(message))
    this.state.messages.push(message)
    this.state.lastMsgTime = time

    // Track message count (matches original reflector prometheusMessagesCounter)
    this.metrics.messagesTotal++

    // Record latency in histogram (matches original reflector prometheusLatencyHistogram)
    // Using the latency extracted BEFORE rawtime modification
    if (typeof latency === 'number' && latency > 0 && latency < 60000) recordLatency(this.metrics, latency)

    // CRITICAL: Await storage write to ensure message persists before hibernation
    // This prevents message loss if DO hibernates immediately after sending
    await this.ctx.storage.put('state', this.state)
    console.log(`[${this.sessionId}] Message persisted: seq=${this.state.seq}, buffer size=${this.state.messages.length}`)
  }

  /**
   * Handle PING - latency measurement
   * Note: PONG does NOT include session id (matches original reflector)
   */
  private handlePing(ws: WebSocket, args: unknown): void {
    // If rawtime flag is set and args is an object, add rawTime (matches original reflector)
    if (this.state?.flags?.rawtime && typeof args === 'object' && args !== null) {
      ;(args as Record<string, unknown>).rawTime = getRawTime(this.state)
    }

    const pongMsg = { action: 'PONG', args }
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

  /** Purge buffered messages up to the given snapshot seq (matches original reflector) */
  private purgeMessagesUpTo(snapshotSeq: number): void {
    if (!this.state) return
    const msgs = this.state.messages
    if (msgs.length > 0) {
      const firstToKeep = msgs.findIndex((msg) => after(snapshotSeq, msg[1] as number))
      if (firstToKeep > 0) {
        msgs.splice(0, firstToKeep)
        console.log(`[${this.sessionId}] Purged ${firstToKeep} messages, keeping ${msgs.length}`)
      } else if (firstToKeep === -1) {
        msgs.length = 0
        console.log(`[${this.sessionId}] Purged all messages`)
      }
    }
  }

  /**
   * Handle SNAP - snapshot operations
   * Supports both:
   * 1. Standard Croquet protocol: args = { time, seq, hash, url } (client uploaded to file server)
   * 2. Custom direct protocol: args = { action: 'request'|'response', ... } (client sends data via WS)
   */
  private async handleSnap(ws: WebSocket, attachment: WSAttachment, args: Record<string, unknown>): Promise<void> {
    const action = args.action as string | undefined

    if (action === 'request') {
      // Custom protocol: client explicitly requests to take a snapshot
      if (this.pendingSnapshot) return

      this.pendingSnapshot = { clientId: attachment.clientId, time: this.state?.time || 0 }
      const snapRequest = {
        id: this.sessionId,
        action: 'SNAP',
        args: { action: 'request', time: this.state?.time, seq: this.state?.seq },
      }
      ws.send(JSON.stringify(snapRequest))
    } else if (action === 'response') {
      // Custom protocol: client sends snapshot data directly
      const { data: snapshotData, time, seq } = args
      console.log(`[${this.sessionId}] SNAP response received: time=${time}, seq=${seq}, dataLen=${(snapshotData as string)?.length || 0}`)
      if (!this.storage || !snapshotData || !this.state) {
        console.log(`[${this.sessionId}] SNAP response skipped: storage=${!!this.storage}, data=${!!snapshotData}, state=${!!this.state}`)
        return
      }

      const snapshotTime = time as number
      const snapshotSeq = seq as number

      try {
        const data = base64ToArrayBuffer(snapshotData as string)
        await this.storage.save(data, snapshotTime, snapshotSeq)

        this.purgeMessagesUpTo(snapshotSeq)

        // Update snapshot metadata
        this.state.snapshotTime = snapshotTime
        this.state.snapshotSeq = snapshotSeq
        this.state.snapshotUrl = `snapshot:${snapshotSeq}` // Reference for latest

        // Record in unified snapshot history for synqmanager visibility
        if (!this.state.snapshotHistory) this.state.snapshotHistory = []
        this.state.snapshotHistory.push({
          time: snapshotTime,
          seq: snapshotSeq,
          size: data.byteLength,
          createdAt: Date.now(),
          source: 'direct',
          r2Key: `sessions/${this.sessionId}/snapshots/${snapshotTime}-${snapshotSeq}.bin`,
        })
        if (this.state.snapshotHistory.length > 20) {
          this.state.snapshotHistory = this.state.snapshotHistory.slice(-20)
        }

        await this.ctx.storage.put('state', this.state)

        console.log(`[${this.sessionId}] Snapshot saved: time=${snapshotTime}, seq=${snapshotSeq}, size=${data.byteLength}`)
      } catch (err) {
        console.error(`[${this.sessionId}] Failed to save snapshot:`, err)
      }

      this.pendingSnapshot = null
    } else if (args.url) {
      // Standard Croquet protocol: client uploaded snapshot to file server and announces URL
      // Format: { time, seq, hash, url, auditStats?, dissident? }
      const { time, seq, hash, url, dissident } = args
      const snapshotTime = time as number
      const snapshotSeq = seq as number

      if (dissident) {
        console.log(`[${this.sessionId}] Dissident snapshot from ${attachment.clientId} - ignoring`)
        return
      }

      if (!this.state) return

      // Ignore if not newer than current snapshot (matches original reflector)
      if (snapshotTime <= (this.state.snapshotTime || -1)) {
        console.log(`[${this.sessionId}] Ignoring snapshot: time=${snapshotTime} <= current=${this.state.snapshotTime}`)
        return
      }

      console.log(`[${this.sessionId}] SNAP from client: time=${snapshotTime}, seq=${snapshotSeq}, hash=${hash}, url=${(url as string)?.slice(0, 80)}...`)

      this.purgeMessagesUpTo(snapshotSeq)

      // Store snapshot URL and metadata (matches original reflector: island.snapshotUrl = url)
      this.state.snapshotTime = snapshotTime
      this.state.snapshotSeq = snapshotSeq
      this.state.snapshotUrl = url as string

      // Record in unified snapshot history for synqmanager visibility
      if (!this.state.snapshotHistory) this.state.snapshotHistory = []
      let size = 0
      const fileUrl = url as string
      const filesPrefix = '/files/'
      const idx = fileUrl.indexOf(filesPrefix)
      if (idx !== -1 && this.env.SNAPSHOTS) {
        try {
          const r2Key = `files/${fileUrl.slice(idx + filesPrefix.length)}`
          const head = await this.env.SNAPSHOTS.head(r2Key)
          if (head) size = head.size
        } catch {
          // R2 head failed, size stays 0
        }
      }
      this.state.snapshotHistory.push({
        time: snapshotTime,
        seq: snapshotSeq,
        size,
        createdAt: Date.now(),
        source: 'file-server',
        url: fileUrl,
      })
      if (this.state.snapshotHistory.length > 20) {
        this.state.snapshotHistory = this.state.snapshotHistory.slice(-20)
      }

      await this.ctx.storage.put('state', this.state)

      console.log(
        `[${this.sessionId}] Snapshot recorded: time=${snapshotTime}, seq=${snapshotSeq}, size=${size}, messages remaining=${this.state.messages.length}`
      )
    }
  }

  /**
   * Handle TUTTI - Byzantine voting mechanism (matches original reflector)
   * Collects votes from all active clients, waits for timeout or quorum, broadcasts decision
   * Args format: [sendTime, _deprecatedTuttiSeq, payload, firstMsg, wantsVote, tallyTarget, tuttiKey]
   */
  private handleTutti(args: unknown[]): void {
    if (!this.state) return

    // Parse args (matches original reflector format)
    const [sendTime, , payload, firstMsg, wantsVote, tallyTarget, tuttiKey] = args as [
      number,
      unknown,
      string,
      unknown[] | undefined,
      boolean | undefined,
      unknown,
      string,
    ]

    // Initialize tallies tracking if needed
    if (!this.state.tallies) this.state.tallies = {}
    if (!this.state.completedTallies) this.state.completedTallies = {}

    let tally = this.state.tallies[tuttiKey]

    if (!tally) {
      // Either first client we've heard from, or one that missed the party entirely
      const historyLimit = this.cleanUpCompletedTallies()

      // Reject if vote is too old
      if (sendTime < historyLimit) {
        console.log(`[${this.sessionId}] TUTTI: rejecting old tally ${tuttiKey} (${this.state.time - sendTime}ms old)`)
        return
      }

      // Reject if already completed
      if (this.state.completedTallies[tuttiKey]) {
        console.log(`[${this.sessionId}] TUTTI: rejecting vote for completed tally ${tuttiKey}`)
        return
      }

      // Send firstMsg if present (e.g., snapshot request message)
      if (firstMsg) {
        const sendableMsg = [...firstMsg]
        if (this.state.flags?.rawtime) sendableMsg.push(0) // will be overwritten with time value
        this.sendMessage(sendableMsg)
      }

      // Create new tally
      // Count only active clients (matches original reflector's island.clients.size)
      // Original comment: "we could ignore clients that are not active, but with TALLY_INTERVAL of 1000ms
      // it's painless to give them all a chance"
      const sockets = this.ctx.getWebSockets()
      const activeClientCount = sockets.filter((s) => {
        const att = s.deserializeAttachment() as WSAttachment
        return att?.active === true
      }).length
      tally = this.state.tallies[tuttiKey] = {
        sendTime,
        expecting: activeClientCount,
        payloads: {},
        startedAt: now(),
        wantsVote,
        tallyTarget,
        firstMsg,
      }
    }

    // Record vote (payload is a string hash, count votes per hash)
    const payloadKey = String(payload)
    tally.payloads[payloadKey] = (tally.payloads[payloadKey] || 0) + 1

    // Check if all votes collected
    if (--tally.expecting === 0) this.completeTally(tuttiKey)

    this.ctx.storage.put('state', this.state)
  }

  /**
   * Complete a tally and broadcast results (matches original reflector tallyComplete)
   */
  private completeTally(tuttiKey: string): void {
    if (!this.state?.tallies?.[tuttiKey]) return

    const tally = this.state.tallies[tuttiKey]
    const { sendTime, expecting: missing, wantsVote, tallyTarget, payloads } = tally

    if (missing > 0) console.log(`[${this.sessionId}] TUTTI ${tuttiKey}: missing ${missing} client(s) from tally`)

    // Send tally result if wantsVote or multiple different payloads
    if (wantsVote || Object.keys(payloads).length > 1) {
      const tallyPayload = {
        what: 'tally',
        sendTime,
        tally: payloads,
        tallyTarget,
        tuttiKey,
        missingClients: missing,
      }
      const msg: unknown[] = [0, 0, tallyPayload]
      if (this.state.flags?.rawtime) msg.push(0) // placeholder for rawtime
      this.sendMessage(msg)
    }

    // Move to completed tallies
    delete this.state.tallies[tuttiKey]
    if (!this.state.completedTallies) this.state.completedTallies = {}
    this.state.completedTallies[tuttiKey] = sendTime
    this.cleanUpCompletedTallies()

    console.log(`[${this.sessionId}] TUTTI ${tuttiKey}: tally complete with ${Object.keys(payloads).length} unique votes`)
  }

  /**
   * Clean up old completed tallies (matches original reflector cleanUpCompletedTallies)
   * Returns the history limit (oldest sendTime we're tracking)
   */
  private cleanUpCompletedTallies(): number {
    if (!this.state) return 0
    if (!this.state.completedTallies) this.state.completedTallies = {}

    const completed = this.state.completedTallies
    const currentTime = this.state.time

    // Calculate history limit based on MAX_TALLY_AGE
    let historyLimit = Math.max(0, currentTime - MAX_TALLY_AGE + 1)

    // Get send times that are recent enough to keep
    const sendTimesToKeep = Object.values(completed).filter((time) => time >= historyLimit)

    // If too many recent tallies, cap at MAX_COMPLETED_TALLIES
    let newSentinel: number | undefined
    if (sendTimesToKeep.length > MAX_COMPLETED_TALLIES) {
      sendTimesToKeep.sort((a, b) => b - a) // descending, most recent first
      historyLimit = sendTimesToKeep[MAX_COMPLETED_TALLIES - 2] // leave room for sentinel
      newSentinel = sendTimesToKeep[MAX_COMPLETED_TALLIES - 1]
    }

    // Remove entries older than historyLimit
    const sentinel = completed[''] // sentinel entry has empty string key
    Object.keys(completed).forEach((keyOrSeq) => {
      if (completed[keyOrSeq] < historyLimit) delete completed[keyOrSeq]
    })

    // Add sentinel if needed
    if (newSentinel !== undefined) completed[''] = newSentinel

    // Return the effective history limit
    return sentinel !== undefined ? sentinel : historyLimit
  }

  /**
   * Check for timed-out tallies (called from alarm)
   */
  private checkTallyTimeouts(): void {
    if (!this.state?.tallies) return

    const currentTime = now()
    const timedOutKeys: string[] = []

    for (const [tuttiKey, tally] of Object.entries(this.state.tallies)) {
      if (currentTime - tally.startedAt >= TALLY_INTERVAL) timedOutKeys.push(tuttiKey)
    }

    for (const tuttiKey of timedOutKeys) {
      console.log(`[${this.sessionId}] TUTTI ${tuttiKey}: timeout after ${TALLY_INTERVAL}ms`)
      this.completeTally(tuttiKey)
    }

    if (timedOutKeys.length > 0) this.ctx.storage.put('state', this.state)
  }

  /**
   * Internal helper to send a message (advances time, increments seq, broadcasts)
   */
  private sendMessage(messageContent: unknown[]): void {
    if (!this.state) return

    const time = advanceTime(this.state, 'TUTTI')
    this.state.seq = (this.state.seq + 1) >>> 0
    this.state.lastActivity = now()

    const message = [...messageContent]
    message[0] = time
    message[1] = this.state.seq

    // Add _size property to non-string payloads for accounting (matches original reflector)
    if (typeof message[2] !== 'string' && message[2] != null) {
      ;(message[2] as Record<string, unknown>)._size = JSON.stringify(message[2]).length
    }

    // If rawtime flag is set, overwrite last element with raw time
    if (this.state.flags?.rawtime && message.length > 3) message[message.length - 1] = getRawTime(this.state)

    // Broadcast RECV to all clients
    const recvMsg = { id: this.sessionId, action: 'RECV', args: message }
    this.broadcast(JSON.stringify(recvMsg))

    // Buffer for late-joiner catchup
    this.state.messages.push(message)
    this.state.lastMsgTime = time
  }

  /**
   * Handle LOG - client logging (matches original reflector)
   * Logs client messages to server console for debugging
   */
  private handleLog(attachment: WSAttachment, args: unknown[]): void {
    const [level, ...logArgs] = args
    const prefix = `[${this.sessionId}] [${attachment.clientId}]`

    // Map log level to console method (matches original reflector)
    switch (level) {
      case 'error':
        console.error(prefix, ...logArgs)
        break
      case 'warn':
        console.warn(prefix, ...logArgs)
        break
      case 'info':
        console.info(prefix, ...logArgs)
        break
      default:
        console.log(prefix, ...logArgs)
    }
  }

  /**
   * Handle SAVE - client uploaded persistent data
   * Matches original reflector SAVE behavior
   *
   * Important: SAVE stores the URL for FUTURE sessions, NOT the current session.
   * The current session's persistentUrl is set once at join time and never updated.
   */
  private handleSave(attachment: WSAttachment, args: { persistTime: number; url: string; dissident?: unknown }): void {
    const { persistTime, url, dissident } = args

    // If dissident flag is set, this is a mismatch notification - just log it
    if (dissident) {
      console.log(`[${this.sessionId}] [${attachment.clientId}] Dissident persistent data @${persistTime}: ${url}`)
      return
    }

    // Validate that we have appId and persistentId (matches original reflector)
    const { appId, persistentId } = this.state || {}
    if (!appId || !persistentId) {
      console.warn(`[${this.sessionId}] [${attachment.clientId}] SAVE rejected - missing appId or persistentId`)
      return
    }

    // Log the persistent data save
    console.log(`[${this.sessionId}] [${attachment.clientId}] Persistent data @${persistTime}: ${url}`)

    // Store the URL via registry for FUTURE sessions (fire-and-forget)
    // Important: Do NOT update this.state.persistentUrl - it's only for future sessions
    this.storePersistentUrl(appId, persistentId, url)
      .then((success) => {
        if (success) console.log(`[${this.sessionId}] [${attachment.clientId}] Persistent data stored successfully`)
        else console.error(`[${this.sessionId}] [${attachment.clientId}] Failed to store persistent data`)
      })
      .catch((err) => {
        console.error(`[${this.sessionId}] [${attachment.clientId}] Error storing persistent data:`, err)
      })
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
   *
   * CRITICAL: scheduleTick() must ALWAYS be called at the end, even on error.
   * Unlike the original reflector's setInterval (which fires unconditionally),
   * the alarm-based approach requires explicit rescheduling. If scheduleTick()
   * is missed, ticking stops permanently until a new client connects.
   */
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) {
      // No clients - session timed out
      // IMPORTANT: Do NOT delete state - preserve it for reconnection!
      // The message buffer contains messages since last snapshot, needed for late-joiner catchup.
      // State will naturally be cleaned up when DO is evicted from memory after extended inactivity.
      console.log(`[${this.sessionId}] Session timed out - preserving state for reconnection (${this.state?.messages.length || 0} messages buffered)`)
      await this.markSessionInactive() // Mark as inactive (TTL will eventually expire in KV)
      return
    }

    try {
      // Check for unresponsive clients (matches original reflector)
      const currentTime = now()
      for (const ws of sockets) {
        try {
          const attachment = ws.deserializeAttachment() as WSAttachment | null
          if (!attachment) continue

          const inactivity = currentTime - attachment.lastSeen
          if (inactivity > DISCONNECT_THRESHOLD_MS) {
            // Client unresponsive for too long - disconnect
            console.log(`[${this.sessionId}] Disconnecting unresponsive client ${attachment.clientId} (inactive ${inactivity}ms)`)
            ws.close(CLOSE_REASONS.UNRESPONSIVE[0], CLOSE_REASONS.UNRESPONSIVE[1])
          } else if (inactivity > PING_THRESHOLD_MS) {
            // Client hasn't been heard from in a while - send server-initiated PING
            const pingMsg = { id: this.sessionId, action: 'PING', args: currentTime }
            ws.send(JSON.stringify(pingMsg))
          }
        } catch (err) {
          console.error(`[${this.sessionId}] Error checking client activity:`, err)
        }
      }

      // Check for timed-out TUTTI tallies (matches original reflector TALLY_INTERVAL)
      this.checkTallyTimeouts()

      // Tick: advance time and broadcast (matches original reflector TICK function)
      if (this.state) {
        // Check if anyone is listening (active, connected) - matches original reflector
        const sendingTicksTo = (ws: WebSocket): boolean => {
          const att = ws.deserializeAttachment() as WSAttachment
          return att?.active === true && ws.readyState === WebSocket.OPEN
        }
        const anyoneListening = sockets.some(sendingTicksTo)

        // Only advance time and send ticks if someone is listening,
        // but ALWAYS continue to scheduleTick() below (unlike the original reflector's
        // setInterval, alarm-based ticking stops if we don't reschedule).
        if (anyoneListening) {
          // Capture the time loaded from storage (before advanceTime modifies it)
          const storedTime = this.state.time
          const time = advanceTime(this.state, 'TICK')
          this.state.lastTick = time

          // Check rawtime flag - if set, send raw monotonic time instead of scaled time
          // (matches original reflector behavior)
          const tickTime = this.state.flags?.rawtime ? currentTime - this.state.rawStart : time
          const tickMsg = JSON.stringify({ id: this.sessionId, action: 'TICK', args: tickTime })

          // Only send to active, connected clients (matches original reflector)
          sockets.forEach((ws) => {
            try {
              if (sendingTicksTo(ws)) ws.send(tickMsg)
            } catch (err) {
              console.error(`[${this.sessionId}] Error sending tick:`, err)
            }
          })

          // Track tick count (matches original reflector prometheusTicksCounter)
          this.metrics.ticksTotal++

          // Persist state periodically (~every 5 seconds)
          // With DO hibernation, in-memory state is lost between alarm wake-ups.
          // hydrate() reloads from storage each time, so we must persist the updated
          // time regularly. Compare against the time loaded from storage to know
          // how long since last persist.
          if (time - storedTime > 5000) {
            await this.ctx.storage.put('state', this.state)
          }
        }
      }

      // Update session tracking periodically (keeps session visible in manager UI)
      // Session KV records use TTL, so we need periodic updates
      if (this.trackedInKV) this.updateSessionTracking(sockets.length)

      // Prune old snapshots periodically (reuse currentTime from above)
      const currentTimeForPrune = now()
      if (this.storage && currentTimeForPrune - this.lastSnapshotPrune > SNAPSHOT_PRUNE_INTERVAL_MS) {
        this.storage.prune(5).catch((err) => console.error('Snapshot prune failed:', err))
        this.lastSnapshotPrune = currentTimeForPrune
      }
    } catch (err) {
      console.error(`[${this.sessionId}] Alarm handler error:`, err)
    }

    // ALWAYS reschedule - the tick loop must never die while clients are connected.
    // This is outside the try/catch to ensure it runs even on error.
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

  // ============================================================================
  // Session Tracking - Direct KV storage for manager UI visibility
  // ============================================================================

  /**
   * Lookup persistent data URL from PERSIST KV
   * Called on JOIN when persistentId is provided but no snapshot exists
   */
  private async lookupPersistentUrl(appId: string, persistentId: string): Promise<string | null> {
    if (!this.env.PERSIST) return null

    try {
      const key = `persist:${appId}:${persistentId}`
      const data = await this.env.PERSIST.get<{ url: string; updatedAt: number }>(key, 'json')
      return data?.url || null
    } catch (err) {
      console.error(`[${this.sessionId}] Persistent data lookup error:`, err)
      return null
    }
  }

  /**
   * Store persistent data URL to PERSIST KV
   * Called on SAVE to persist URL for future sessions
   */
  private async storePersistentUrl(appId: string, persistentId: string, url: string): Promise<boolean> {
    if (!this.env.PERSIST) return false

    try {
      const key = `persist:${appId}:${persistentId}`
      await this.env.PERSIST.put(key, JSON.stringify({ url, updatedAt: Date.now() }))
      return true
    } catch (err) {
      console.error(`[${this.sessionId}] Persistent data store error:`, err)
      return false
    }
  }

  /**
   * Track session in SESSIONS KV (makes it visible in manager UI)
   * Called when first client joins
   */
  private async trackSession(clientCount: number, appId?: string): Promise<void> {
    if (!this.env.SESSIONS) return
    if (this.trackedInKV) return

    // Store appId for later updates
    if (appId) this.trackedAppId = appId

    try {
      const ttl = parseInt(this.env.SESSION_TTL_SECONDS || '300', 10)
      const record = {
        sessionId: this.sessionId,
        clientCount,
        appId,
        synchronizerUrl: this.env.CLUSTER_LABEL || 'synq',
        colo: this.colo,
        doColo: this.doColo,
        lat: this.env.SYNC_LAT ? parseFloat(this.env.SYNC_LAT) : undefined,
        lon: this.env.SYNC_LON ? parseFloat(this.env.SYNC_LON) : undefined,
        region: this.env.SYNC_REGION,
        metrics: this.metrics,
        clientLocations: this.getClientLocations(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
      }

      await this.env.SESSIONS.put(`session:${this.sessionId}`, JSON.stringify(record), { expirationTtl: ttl })

      this.trackedInKV = true
      this.lastSessionUpdate = Date.now()
      console.log(`[${this.sessionId}] Session tracked in KV`)
    } catch (err) {
      console.error(`[${this.sessionId}] Session tracking error:`, err)
    }
  }

  /**
   * Mark session as inactive in SESSIONS KV (but don't delete)
   * Session remains visible in manager UI until TTL expires
   * Called when last client leaves
   */
  private async markSessionInactive(): Promise<void> {
    if (!this.env.SESSIONS) return
    if (!this.trackedInKV) return

    try {
      const ttl = parseInt(this.env.SESSION_TTL_SECONDS || '300', 10)
      const record = {
        sessionId: this.sessionId,
        clientCount: 0,
        status: 'inactive', // Mark as inactive instead of deleting
        appId: this.trackedAppId,
        synchronizerUrl: this.env.CLUSTER_LABEL || 'synq',
        colo: this.colo,
        doColo: this.doColo,
        lat: this.env.SYNC_LAT ? parseFloat(this.env.SYNC_LAT) : undefined,
        lon: this.env.SYNC_LON ? parseFloat(this.env.SYNC_LON) : undefined,
        region: this.env.SYNC_REGION,
        metrics: this.metrics,
        hasSnapshot: !!this.state?.snapshotUrl,
        lastSeen: Date.now(),
        inactiveSince: Date.now(),
      }

      await this.env.SESSIONS.put(`session:${this.sessionId}`, JSON.stringify(record), { expirationTtl: ttl })
      console.log(`[${this.sessionId}] Session marked inactive in KV (TTL: ${ttl}s)`)
    } catch (err) {
      console.error(`[${this.sessionId}] Session inactive marking error:`, err)
    }
  }

  /**
   * Untrack session from SESSIONS KV (removes from manager UI)
   * Called for explicit deletion
   */
  private async untrackSession(): Promise<void> {
    if (!this.env.SESSIONS) return
    if (!this.trackedInKV) return

    try {
      await this.env.SESSIONS.delete(`session:${this.sessionId}`)
      this.trackedInKV = false
      console.log(`[${this.sessionId}] Session untracked from KV`)
    } catch (err) {
      console.error(`[${this.sessionId}] Session untrack error:`, err)
    }
  }

  /**
   * Update session in SESSIONS KV (keeps it visible with fresh TTL)
   * Called periodically from alarm
   */
  private async updateSessionTracking(clientCount: number): Promise<void> {
    if (!this.env.SESSIONS) return
    if (!this.trackedInKV) return

    const HEARTBEAT_INTERVAL_MS = 60000 // 1 minute
    const timeSinceLastUpdate = Date.now() - this.lastSessionUpdate

    if (timeSinceLastUpdate < HEARTBEAT_INTERVAL_MS) return

    try {
      const ttl = parseInt(this.env.SESSION_TTL_SECONDS || '300', 10)
      const record = {
        sessionId: this.sessionId,
        appId: this.trackedAppId,
        synchronizerUrl: this.env.CLUSTER_LABEL || 'synq',
        clientCount,
        colo: this.colo,
        doColo: this.doColo,
        metrics: this.metrics,
        clientLocations: this.getClientLocations(),
        lastSeen: Date.now(),
      }

      await this.env.SESSIONS.put(`session:${this.sessionId}`, JSON.stringify(record), { expirationTtl: ttl })
      this.lastSessionUpdate = Date.now()
    } catch (err) {
      console.error(`[${this.sessionId}] Session update error:`, err)
    }
  }

  /**
   * Build client locations array for map visualization
   * Returns array of { clientId, colo, isLeader } for each active client
   * The leader is the first client that became active (oldest joinedAt among active clients)
   */
  private getActiveClientData(): Array<{ clientId: string; colo: string; joinedAt: number }> {
    const sockets = this.ctx.getWebSockets()
    const clients: Array<{ clientId: string; colo: string; joinedAt: number }> = []
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as WSAttachment
      if (att?.active && att.colo) clients.push({ clientId: att.clientId, colo: att.colo, joinedAt: att.joinedAt })
    }
    return clients
  }

  private getClientLocations(): ClientLocation[] {
    return buildClientLocations(this.getActiveClientData())
  }

  /** Detect DO's actual location using Cloudflare trace endpoint */
  private async detectDoLocation(): Promise<void> {
    if (this.doColo || this.doLocationDetectionStarted) return
    this.doLocationDetectionStarted = true

    const colo = await detectColoFromTrace()
    if (colo) {
      this.doColo = colo
      await this.ctx.storage.put('doColo', this.doColo)
      console.log(`[${this.sessionId}] DO location detected: ${this.doColo}`)
    } else console.warn(`[${this.sessionId}] DO location detection failed`)
  }

  /**
   * Get detailed session info for inspector/debugging
   * Returns comprehensive session state, client info, and metrics
   * Note: Even when session is inactive (state=null), snapshots may still exist in R2
   */
  private async getSessionInfo(): Promise<Record<string, unknown>> {
    const sockets = this.ctx.getWebSockets()
    const clients: Array<Record<string, unknown>> = []

    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as WSAttachment
      if (att) {
        clients.push({
          clientId: att.clientId,
          active: att.active,
          joined: att.joined,
          colo: att.colo,
          joinedAt: att.joinedAt,
          lastSeen: att.lastSeen,
          userId: att.userId,
        })
      }
    }

    // Sort clients by joinedAt (leader first)
    clients.sort((a, b) => (a.joinedAt as number) - (b.joinedAt as number))
    if (clients.length > 0) clients[0].isLeader = true

    // Get snapshot info - from state if active, or from R2 if inactive
    let snapshotInfo: Record<string, unknown> | null = null
    if (this.state) {
      snapshotInfo = {
        time: this.state.snapshotTime,
        seq: this.state.snapshotSeq,
        url: this.state.snapshotUrl ? 'present' : null,
        persistentUrl: this.state.persistentUrl ? 'present' : null,
      }
    } else if (this.storage) {
      // Session inactive but snapshots may exist in R2
      try {
        const latest = await this.storage.loadLatest()
        if (latest) {
          snapshotInfo = {
            time: latest.meta.time,
            seq: latest.meta.seq,
            url: 'present (from R2)',
            persistentUrl: null,
          }
        }
      } catch {
        // Ignore errors loading snapshot for inactive session
      }
    }

    return {
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      status: this.state ? 'active' : snapshotInfo ? 'inactive' : 'uninitialized',
      location: {
        edge: this.colo,
        durable: this.doColo,
      },
      timing: this.state
        ? {
            time: this.state.time,
            seq: this.state.seq,
            tick: this.state.tick,
            scale: this.state.scale,
            createdAt: this.state.createdAt,
            lastActivity: this.state.lastActivity,
            lastTick: this.state.lastTick,
            lastMsgTime: this.state.lastMsgTime,
          }
        : null,
      snapshot: snapshotInfo,
      messages: {
        buffered: this.state?.messages?.length || 0,
        maxBuffer: MAX_MESSAGES,
        requThreshold: REQU_SNAPSHOT,
      },
      clients: {
        count: clients.length,
        list: clients,
      },
      metrics: this.metrics,
      tallies: this.state?.tallies ? Object.keys(this.state.tallies).length : 0,
      timeline: this.state?.timeline,
      flags: this.state?.flags,
    }
  }

  /**
   * Get list of snapshots for this session (unified across both protocols)
   */
  private async getSnapshotList(): Promise<Record<string, unknown>> {
    const current = this.state ? { time: this.state.snapshotTime, seq: this.state.snapshotSeq } : null

    // Primary: read from unified snapshot history in DO state
    if (this.state?.snapshotHistory?.length) {
      return {
        sessionId: this.sessionId,
        snapshots: this.state.snapshotHistory.map((s) => ({
          time: s.time,
          seq: s.seq,
          size: s.size,
          sizeHuman: formatBytes(s.size),
          createdAt: s.createdAt,
          createdAtHuman: new Date(s.createdAt).toISOString(),
          source: s.source,
        })),
        current,
      }
    }

    // Fallback: R2 scan for legacy sessions without snapshotHistory
    if (!this.storage) {
      return { sessionId: this.sessionId, snapshots: [], current }
    }

    try {
      const snapshots = await this.storage.list(20)
      return {
        sessionId: this.sessionId,
        snapshots: snapshots.map((s) => ({
          time: s.time,
          seq: s.seq,
          size: s.size,
          sizeHuman: formatBytes(s.size),
          createdAt: s.createdAt,
          createdAtHuman: new Date(s.createdAt).toISOString(),
          source: 'direct',
        })),
        current,
      }
    } catch (err) {
      return { sessionId: this.sessionId, snapshots: [], error: String(err) }
    }
  }

  /**
   * Save message buffer to R2 for durability
   * Called when last client disconnects to ensure zero data loss even if DO is evicted
   */
  private async saveMessageBufferToR2(): Promise<void> {
    if (!this.env.SNAPSHOTS || !this.state) return
    if (this.state.messages.length === 0) {
      console.log(`[${this.sessionId}] No messages to backup to R2`)
      return
    }

    try {
      const key = `${this.sessionId}/message-buffer.json`
      const data = {
        time: this.state.time,
        seq: this.state.seq,
        snapshotTime: this.state.snapshotTime,
        snapshotSeq: this.state.snapshotSeq,
        messages: this.state.messages,
        timeline: this.state.timeline,
        savedAt: Date.now(),
      }

      await this.env.SNAPSHOTS.put(key, JSON.stringify(data), {
        customMetadata: {
          time: String(this.state.time),
          seq: String(this.state.seq),
          messageCount: String(this.state.messages.length),
        },
      })

      console.log(`[${this.sessionId}] Saved ${this.state.messages.length} messages to R2 backup (seq: ${this.state.seq})`)
    } catch (err) {
      console.error(`[${this.sessionId}] Failed to save message buffer to R2:`, err)
    }
  }

  /**
   * Load message buffer from R2 if available
   * Returns message buffer or null if not found
   */
  private async loadMessageBufferFromR2(): Promise<{
    time: number
    seq: number
    snapshotTime?: number
    snapshotSeq?: number
    messages: unknown[][]
    timeline: string
  } | null> {
    if (!this.env.SNAPSHOTS) return null

    try {
      const key = `${this.sessionId}/message-buffer.json`
      const obj = await this.env.SNAPSHOTS.get(key)
      if (!obj) return null

      const data = JSON.parse(await obj.text())
      console.log(`[${this.sessionId}] Loaded message buffer from R2: ${data.messages.length} messages (seq: ${data.seq})`)
      return data
    } catch (err) {
      console.log(`[${this.sessionId}] No message buffer found in R2 (or error loading):`, err)
      return null
    }
  }
}

/** Format bytes to human-readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
