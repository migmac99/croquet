import { DurableObject } from 'cloudflare:workers'
import type { Env, ClientMeta, SessionState } from './types'
import { CLOSE_REASONS } from './types'
import { SnapshotStorage } from './storage'

const TICK_MS = 50 // 20 ticks per second
const USERS_BROADCAST_INTERVAL_MS = 1000
const SNAPSHOT_PRUNE_INTERVAL_MS = 300000 // 5 minutes

/**
 * Attachment stored with each WebSocket (survives hibernation)
 */
interface WSAttachment {
  clientId: string
  userId?: string
  userIp: string
  joinedAt: number
  lastSeen: number
  joined: boolean // Has sent JOIN message
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
  private lastUsersBroadcast = 0
  private lastSnapshotPrune = 0
  private pendingSnapshot: { clientId: string; time: number } | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // Restore state on wake from hibernation
    this.ctx.blockConcurrencyWhile(async () => {
      await this.hydrate()
    })
  }

  /**
   * Hydrate state from storage (called on wake from hibernation)
   */
  private async hydrate(): Promise<void> {
    const stored = await this.ctx.storage.get<SessionState>('state')
    if (stored) {
      this.state = stored
      this.storage = new SnapshotStorage(this.env.SNAPSHOTS, this.sessionId)
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
    // Tags allow us to find specific WebSockets later
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
    // Get attachment (rehydrated from serialized form)
    const attachment = ws.deserializeAttachment() as WSAttachment
    if (!attachment) {
      console.error('No attachment found for WebSocket')
      return
    }

    attachment.lastSeen = Date.now()
    ws.serializeAttachment(attachment)

    try {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message)
      const msg = JSON.parse(data)
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

    console.log(`[${this.sessionId}] Client disconnected: ${clientId} (${code}: ${reason})`)

    // Broadcast updated users
    this.broadcastUsers()

    // Check if session is now empty
    const remaining = this.ctx.getWebSockets().length
    if (remaining === 0) {
      // Schedule cleanup via alarm
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
   * Process a message from a client
   */
  private async handleMessage(ws: WebSocket, attachment: WSAttachment, msg: unknown[]): Promise<void> {
    const type = msg[0] as string

    switch (type) {
      case 'JOIN':
        await this.handleJoin(ws, attachment, msg)
        break
      case 'SEND':
        this.handleSend(attachment, msg)
        break
      case 'PING':
        this.handlePing(ws, msg)
        break
      case 'SNAP':
        await this.handleSnap(ws, attachment, msg)
        break
      case 'REQU':
        this.handleRequ(ws, msg)
        break
      default:
        console.warn(`[${this.sessionId}] Unknown message type: ${type}`)
    }
  }

  /**
   * Handle JOIN - client joining the session
   */
  private async handleJoin(ws: WebSocket, attachment: WSAttachment, msg: unknown[]): Promise<void> {
    const [, args] = msg as [string, { version?: string; user?: string; details?: Record<string, unknown> }]

    // Update attachment
    attachment.userId = args.user
    attachment.joined = true
    ws.serializeAttachment(attachment)

    // Initialize session state if first client
    if (!this.state) {
      this.state = {
        id: this.sessionId,
        time: Date.now(),
        seq: 0,
        createdAt: Date.now(),
        lastActivity: Date.now(),
      }
      await this.ctx.storage.put('state', this.state)
      this.storage = new SnapshotStorage(this.env.SNAPSHOTS, this.sessionId)
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

    // Build users list from all connected WebSockets
    const users = this.buildUsersList()

    // Send SYNC response
    const syncMsg: unknown[] = [
      'SYNC',
      {
        time: this.state.time,
        seq: this.state.seq,
        users,
        ...(snapshot && {
          snapshot: this.arrayBufferToBase64(snapshot),
          snapshotTime,
          snapshotSeq,
        }),
      },
    ]

    ws.send(JSON.stringify(syncMsg))

    // Broadcast user joined to others
    this.broadcastUsers()

    // Ensure ticking
    this.scheduleTick()

    console.log(`[${this.sessionId}] JOIN from ${attachment.clientId} (user: ${args.user})`)
  }

  /**
   * Handle SEND - broadcast event to all clients
   */
  private handleSend(attachment: WSAttachment, msg: unknown[]): void {
    if (!this.state) return

    const [, ...payload] = msg
    this.state.seq++
    this.state.time = Date.now()
    this.state.lastActivity = Date.now()

    // Broadcast RECV to all clients
    const recvMsg = JSON.stringify(['RECV', this.state.seq, this.state.time, ...payload])
    this.broadcast(recvMsg)

    // Persist state (debounced via write coalescing)
    this.ctx.storage.put('state', this.state)
  }

  /**
   * Handle PING - latency measurement
   */
  private handlePing(ws: WebSocket, msg: unknown[]): void {
    const [, pingId] = msg
    ws.send(JSON.stringify(['PONG', pingId, Date.now()]))
  }

  /**
   * Handle SNAP - snapshot operations
   */
  private async handleSnap(ws: WebSocket, attachment: WSAttachment, msg: unknown[]): Promise<void> {
    const [, action, ...args] = msg

    if (action === 'request') {
      // Request a snapshot from this client
      if (this.pendingSnapshot) return

      this.pendingSnapshot = { clientId: attachment.clientId, time: this.state?.time || 0 }
      ws.send(JSON.stringify(['SNAP', 'request', this.state?.time, this.state?.seq]))
    } else if (action === 'response') {
      // Receive snapshot data from client
      const [snapshotData, time, seq] = args
      if (!this.storage || !snapshotData) return

      try {
        const data = this.base64ToArrayBuffer(snapshotData as string)
        await this.storage.save(data, time as number, seq as number)

        if (this.state) {
          this.state.snapshotTime = time as number
          this.state.snapshotSeq = seq as number
          await this.ctx.storage.put('state', this.state)
        }

        console.log(`[${this.sessionId}] Snapshot saved: time=${time}, seq=${seq}, size=${data.byteLength}`)
      } catch (err) {
        console.error(`[${this.sessionId}] Failed to save snapshot:`, err)
      }

      this.pendingSnapshot = null
    }
  }

  /**
   * Handle REQU - special requests
   */
  private handleRequ(ws: WebSocket, msg: unknown[]): void {
    const [, reqType] = msg
    if (reqType === 'snapshot' && this.state) ws.send(JSON.stringify(['SNAP', 'request', this.state.time, this.state.seq]))
  }

  /**
   * Schedule the next tick via alarm
   */
  private scheduleTick(): void {
    // Only schedule if we have clients
    if (this.ctx.getWebSockets().length === 0) return

    // Schedule next tick
    this.ctx.storage.setAlarm(Date.now() + TICK_MS)
  }

  /**
   * Handle alarm - used for ticking and cleanup
   */
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets()

    // If no clients, this might be cleanup time
    if (sockets.length === 0) {
      console.log(`[${this.sessionId}] Session idle, ready for hibernation`)
      // Don't delete state - allow rejoin with same state
      // Could optionally prune old snapshots here
      return
    }

    // Tick: advance time and broadcast
    if (this.state) {
      this.state.time = Date.now()
      this.broadcast(JSON.stringify(['TICK', this.state.time]))

      // Persist state periodically (not every tick)
      if (this.state.seq % 100 === 0) await this.ctx.storage.put('state', this.state)
    }

    // Broadcast users periodically
    const now = Date.now()
    if (now - this.lastUsersBroadcast > USERS_BROADCAST_INTERVAL_MS) {
      this.broadcastUsers()
      this.lastUsersBroadcast = now
    }

    // Prune old snapshots periodically
    if (this.storage && now - this.lastSnapshotPrune > SNAPSHOT_PRUNE_INTERVAL_MS) {
      this.storage.prune(5).catch((err) => console.error('Snapshot prune failed:', err))
      this.lastSnapshotPrune = now
    }

    // Schedule next tick
    this.scheduleTick()
  }

  /**
   * Build users list from connected WebSockets
   */
  private buildUsersList(): Record<string, { visibleId?: string; active?: boolean }> {
    const users: Record<string, { visibleId?: string; active?: boolean }> = {}
    const now = Date.now()

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as WSAttachment | null
      if (attachment?.joined) {
        users[attachment.clientId] = {
          visibleId: attachment.userId,
          active: now - attachment.lastSeen < 5000,
        }
      }
    }

    return users
  }

  /**
   * Broadcast USERS message to all clients
   */
  private broadcastUsers(): void {
    const users = this.buildUsersList()
    this.broadcast(JSON.stringify(['USERS', users]))
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
        // WebSocket may have closed, will be cleaned up
        console.error('Broadcast send error:', err)
      }
    }
  }

  /**
   * Get session ID from DO id
   */
  private get sessionId(): string {
    return this.ctx.id.toString()
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
