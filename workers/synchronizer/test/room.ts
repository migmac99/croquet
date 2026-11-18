/**
 * For `src/buffer.test.ts`. A Synchronizer on fakes: a Durable Object state whose storage is a map, sockets whose `send` can be made to throw (a
 * connection that is gone but still listed), and clients that check every message exactly as the vendored client does
 * (`scheduleExternalMessage`: the next number, never an earlier time; SYNC: a seamless rejoin on the same timeline).
 */
import { vi } from 'vitest'
import { Synchronizer } from '../src/synchronizer'

export const INITIAL_SEQ = 0xfffffff0 >>> 0
const next = (s: number) => (s + 1) >>> 0

export class FakeSocket {
  attachment: any = null
  frames: any[] = []
  closed: { code?: number; reason?: string } | null = null
  /** A connection that is gone but still listed: every send throws. */
  dead = false
  readyState = 1
  serializeAttachment(a: any) {
    this.attachment = JSON.parse(JSON.stringify(a))
  }
  deserializeAttachment() {
    return this.attachment ? JSON.parse(JSON.stringify(this.attachment)) : null
  }
  send(s: string) {
    if (this.dead || this.closed) throw new TypeError('WebSocket send() after close')
    this.frames.push(JSON.parse(s))
  }
  close(code?: number, reason?: string) {
    if (this.dead) return // a dead peer never finishes the close: the socket stays listed
    this.closed = { code, reason }
    this.readyState = 3
  }
}

export interface Room {
  sync: any
  sockets: FakeSocket[]
  stored: Map<string, any>
  snapshots: Map<string, { seq: number; time: number; views: string[] }>
  connect(): FakeSocket
  join(ws: FakeSocket, user?: string): Promise<void>
  send(ws: FakeSocket, payload?: unknown): Promise<void>
  drop(ws: FakeSocket, code?: number): Promise<void>
  flush(ms?: number): Promise<void>
  restart(opts?: { dropSockets?: boolean }): Promise<void>
  state(): any
  putFails: boolean
  /** How long each read of the snapshot bucket takes, ms (0: no bucket). */
  bucketMs: number
}

let ids = 0
export async function makeRoom(env: Record<string, unknown> = {}): Promise<Room> {
  const stored = new Map<string, any>()
  const sockets: FakeSocket[] = []
  const room: any = { sockets, stored, snapshots: new Map(), putFails: false, bucketMs: Number(env.bucketMs ?? 0) }
  const ctx = {
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
    storage: {
      get: async (k: string) => (stored.has(k) ? JSON.parse(stored.get(k)) : undefined),
      put: async (k: string, v: unknown) => {
        if (room.putFails) throw new Error('storage put failed')
        stored.set(k, JSON.stringify(v))
      },
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    getWebSockets: () => sockets.filter((s) => !s.closed),
    acceptWebSocket: (ws: FakeSocket) => void sockets.push(ws),
    id: { toString: () => 'do-id' },
  }
  // a snapshot bucket with nothing in it whose reads take `bucketMs`: a join is in flight across them, as it is across
  // the real bucket's
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const bucket = {
    get: async () => (await wait(room.bucketMs), null),
    list: async () => (await wait(room.bucketMs), { objects: [] }),
    put: async () => {},
    delete: async () => {},
    head: async () => null,
  }
  const make = async () => {
    const s = new Synchronizer(ctx as never, { MAX_CLIENTS_PER_SESSION: '100', ...(room.bucketMs ? { SNAPSHOTS: bucket } : {}), ...env } as never)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    return s
  }
  room.sync = await make()
  room.connect = () => {
    const ws = new FakeSocket()
    ws.serializeAttachment({ clientId: `c${++ids}`, userIp: 'x', joinedAt: Date.now(), lastSeen: Date.now(), joined: false, active: false })
    sockets.push(ws)
    return ws
  }
  room.join = async (ws: FakeSocket, user = `u${ids}`) => {
    await room.sync.webSocketMessage(ws, JSON.stringify({ action: 'JOIN', args: { version: 1, user, tove: 'tove', appId: 'app', ticks: { tick: 50 } } }))
  }
  room.send = async (ws: FakeSocket, payload: unknown = 'payload') => {
    await room.sync.webSocketMessage(ws, JSON.stringify({ action: 'SEND', args: [0, 0, payload] }))
  }
  room.drop = async (ws: FakeSocket, code = 1006) => {
    ws.closed = { code }
    await room.sync.webSocketClose(ws, code, 'gone')
  }
  room.flush = async (ms = 250) => {
    await vi.advanceTimersByTimeAsync(ms)
  }
  /** The object evicted and made again from what was stored; a deploy also drops every socket. */
  room.restart = async ({ dropSockets = false } = {}) => {
    // the old object's timers go with it (never `vi.clearAllTimers()`: it sets the fake clock back to its start)
    const was = room.sync as any
    was.stopTickLoop?.()
    if (was.usersTimer) clearTimeout(was.usersTimer)
    was.usersTimer = null
    if (dropSockets) for (const s of sockets) s.closed ??= { code: 1012 }
    room.sync = await make()
  }
  room.state = () => (room.sync as any).state
  return room as Room
}

/** What the vendored client does with what it is sent: throws where the client would. */
export class StrictClient {
  ws: FakeSocket
  seq: number | null = null
  time = 0
  timeline = ''
  /** The latest time the reflector told it (a message's or a tick's): the client's `reflectorTime`. */
  reflectorTime = 0
  /** Sequenced messages that arrived before its first SYNC. */
  early: any[][] = []
  /** How its last SYNC was taken: on with its model, or its model made again. */
  lastSync: 'seamless' | 'reboot' | null = null
  /** Every sequenced message this client's model executed, in order: `seq:payload`. */
  history: string[] = []
  read = 0
  rebooted = 0
  constructor(
    public room: Room,
    public name: string
  ) {
    this.ws = room.connect()
  }
  async join() {
    await this.room.join(this.ws, this.name)
    this.pump()
  }
  /** Reconnects on a new socket, keeping its model (as the client does after a dropped connection). */
  async rejoin() {
    this.ws = this.room.connect()
    this.read = 0
    await this.room.join(this.ws, this.name)
    this.pump()
  }
  private take(m: any[]) {
    if (m[0] < this.time) throw new Error(`past message from reflector ${m[1]}`)
    const want = next(this.seq!)
    if (m[1] !== want) throw new Error(`External message error. Expected message #${want} got #${m[1]}`)
    this.seq = m[1]
    this.time = m[0]
    if (m[0] > this.reflectorTime) this.reflectorTime = m[0]
    this.history.push(`${m[1]}:${typeof m[2] === 'string' ? m[2] : m[2].what}`)
  }
  /** Processes every frame that arrived since the last call. */
  pump() {
    const frames = this.ws.frames
    for (; this.read < frames.length; this.read++) {
      const f = frames[this.read]
      if (f.action === 'SYNC') {
        const a = f.args
        let messages: any[][] = a.messages
        const first = messages[0]
        const P = a.snapshotSeq !== undefined ? a.snapshotSeq : first ? first[1] : a.seq
        const le = (x: number, y: number) => x === y || ((y - x) >>> 0) < 0x80000000
        // the client's own rule, term for term: the same timeline, its number inside what the SYNC covers, and the
        // SYNC's time not before the latest time it was told
        let seamless = this.seq !== null && !!a.timeline && a.timeline === this.timeline && le(P, this.seq) && le(this.seq, a.seq) && a.time >= this.reflectorTime
        this.lastSync = seamless ? 'seamless' : 'reboot'
        if (seamless) {
          let skip = 0
          if (first && le(first[1], this.seq!)) skip = ((this.seq! - first[1] + 1) >>> 0)
          messages = messages.slice(skip)
        } else {
          // install: a snapshot's own number, else a new model
          if (this.seq !== null) this.rebooted++
          this.reflectorTime = 0
          if (a.url) {
            const snap = this.room.snapshots.get(a.url)
            if (!snap) throw new Error(`no such snapshot ${a.url}`)
            this.seq = snap.seq
            this.time = snap.time
            this.history = [`snapshot@${snap.seq}`]
          } else {
            this.seq = INITIAL_SEQ
            this.time = 0
            this.history = ['fresh']
          }
          this.timeline = a.timeline
          this.reflectorTime = Math.max(this.reflectorTime, this.time)
        }
        if (a.time > this.reflectorTime) this.reflectorTime = a.time
        for (const m of messages) this.take(m)
        for (const m of this.early.splice(0)) this.take(m)
      } else if (f.action === 'RECV') {
        // before its SYNC the client only queues (`networkQueue`), and runs the queue after the SYNC's own messages
        if (this.seq === null) this.early.push(f.args)
        else this.take(f.args)
      } else if (f.action === 'TICK') {
        const t = typeof f.args === 'number' ? f.args : f.args.time
        if (t > this.reflectorTime) this.reflectorTime = t
      }
    }
  }
  /** Announces a snapshot of its model as it is now (the standard protocol: a file's address). */
  async snapshot() {
    const url = `https://files/snap-${this.seq}-${this.time}`
    this.room.snapshots.set(url, { seq: this.seq!, time: this.time, views: [] })
    await this.room.sync.webSocketMessage(this.ws, JSON.stringify({ action: 'SNAP', args: { time: this.time, seq: this.seq, hash: 'h', url } }))
  }
}

/** The numbers of the buffer's messages, and where one doesn't follow the one before. */
export function bufferGaps(room: Room): [number, number][] {
  const ms: any[][] = room.state()?.messages ?? []
  const out: [number, number][] = []
  for (let i = 1; i < ms.length; i++) if (ms[i]![1] !== next(ms[i - 1]![1])) out.push([ms[i - 1]![1], ms[i]![1]])
  return out
}
