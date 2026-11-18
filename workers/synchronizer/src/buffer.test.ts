/**
 * The message buffer never has a hole, and a room that already has one can be joined again.
 *
 * What went wrong before (the Palace's editing room on synq.alma.dev, 2026-11-14 to 2026-11-18): a client stopped
 * answering, the synchronizer closed it after 60 s, and the runtime went on listing its socket (the peer never finished
 * the close). Every who-is-here message after that threw at that socket: its number was given out, the message was never
 * buffered, and the clients behind it in the list never got it. The buffer then read 619..940, 2232..: every joiner
 * failed with "Expected message #941 got #2232" and joined again for ever.
 *
 * These cases run the synchronizer on fakes (`../test/room.ts`), with clients that check each message as the vendored
 * client does. The first groups fail on the code from before "Self healing message buffer consistency".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bufferFault } from './synchronizer'
import { bufferGaps, makeRoom, StrictClient } from '../test/room'

const quiet = () => {
  for (const k of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, k).mockImplementation(() => {})
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 })
  quiet()
})
/** Each time the synchronizer found a buffer it couldn't hand to a joiner, in its own words. */
const faults = (): string[] =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .filter((line) => line.includes('BUFFER FAULT'))
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ordinary play', () => {
  it('two clients and a late joiner all run the same messages, in order', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    await a.join()
    await room.flush()
    const b = new StrictClient(room, 'b')
    await b.join()
    await room.flush()
    for (let i = 0; i < 20; i++) {
      await room.send(i % 2 ? a.ws : b.ws, `m${i}`)
      await room.flush(10)
    }
    const c = new StrictClient(room, 'c')
    await c.join()
    await room.flush()
    await room.send(c.ws, 'last')
    for (const x of [a, b, c]) x.pump()
    expect(bufferGaps(room)).toEqual([])
    expect(a.seq).toBe(b.seq)
    expect(c.seq).toBe(a.seq)
    // the late joiner ran the same messages the others did
    expect(c.history.slice(1)).toEqual(a.history.slice(1))
    expect(b.history.slice(-10)).toEqual(a.history.slice(-10))
    expect(faults()).toEqual([])
  })

  it('a snapshot purges the buffer and a joiner starts from it', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    await a.join()
    await room.flush()
    for (let i = 0; i < 10; i++) await room.send(a.ws, `m${i}`)
    a.pump()
    await a.snapshot()
    for (let i = 0; i < 5; i++) await room.send(a.ws, `n${i}`)
    a.pump()
    expect(room.state().messages.length).toBe(5)
    const b = new StrictClient(room, 'b')
    await b.join()
    await room.flush()
    a.pump()
    b.pump()
    expect(b.history[0]).toMatch(/^snapshot@/)
    expect(b.seq).toBe(a.seq)
    expect(bufferGaps(room)).toEqual([])
  })

  it('a client that reconnects ends on the same model as the others (and says how: seamlessly, or from the snapshot)', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    const b = new StrictClient(room, 'b')
    await a.join()
    await b.join()
    await room.flush()
    for (let i = 0; i < 5; i++) await room.send(a.ws, `m${i}`)
    a.pump()
    b.pump()
    await room.drop(b.ws)
    for (let i = 0; i < 5; i++) await room.send(a.ws, `while-away${i}`)
    await room.flush()
    await b.rejoin()
    await room.flush()
    a.pump()
    b.pump()
    // (against this reflector a reconnect loads the snapshot again: its SYNC carries the snapshot's time, which is
    // before the latest time the client was told, so the client's seamless rule never holds; see the same-tick case)
    expect(b.lastSync).toBe('reboot')
    expect(b.seq).toBe(a.seq)
    expect(b.history.slice(1)).toEqual(a.history.slice(1))
  })

  it('a message sent while someone is joining reaches the joiner once', async () => {
    // the join reads the snapshot bucket, and messages go on arriving meanwhile
    const room = await makeRoom({ bucketMs: 30 })
    const a = new StrictClient(room, 'a')
    // (the bucket's reads are on the fake clock: a join is started, the clock moved, then the join awaited)
    const first = a.join()
    await room.flush()
    await first
    await room.flush()
    const b = new StrictClient(room, 'b')
    const joining = b.join().catch((err) => err)
    await room.flush(10)
    for (let i = 0; i < 3; i++) await room.send(a.ws, `during${i}`)
    await room.flush(100)
    const failed = await joining
    await room.flush()
    for (let i = 0; i < 3; i++) await room.send(a.ws, `after${i}`)
    a.pump()
    let error: unknown = failed
    try {
      b.pump()
    } catch (err) {
      error = err
    }
    expect(error).toBeUndefined()
    expect(b.seq).toBe(a.seq)
    expect(b.history.filter((h) => h.includes('during')).length).toBe(3)
    expect(bufferGaps(room)).toEqual([])
  })

  it('a join still queued when the object is made again is never announced to the next people in', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    await a.join()
    await room.flush()
    // b joins, and before its who-is-here message goes out (200 ms) a message stores the state, b's queued join in it
    const b = new StrictClient(room, 'b')
    await b.join()
    await room.send(a.ws, 'stores the state')
    expect(room.state().usersJoined).toEqual(['b'])
    // a deploy: every socket goes, the object is made again from what was stored
    await room.restart({ dropSockets: true })
    const c = new StrictClient(room, 'c')
    await c.join()
    await room.flush()
    const users = c.ws.frames.filter((f) => f.action === 'RECV' && f.args[2]?.what === 'users').map((f) => f.args[2])
    expect(users).toEqual([expect.objectContaining({ active: 1, total: 1, joined: ['c'] })])
  })

  it('a socket that connected but has not joined is sent no sequenced message', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    await a.join()
    await room.flush()
    const idle = room.connect()
    await room.send(a.ws, 'x')
    await room.flush()
    expect(idle.frames.filter((f) => f.action === 'RECV').length).toBe(0)
  })
})

describe('a connection that is gone but still listed', () => {
  it('who-is-here messages still reach the others and stay in the buffer, so a joiner can join', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    await a.join()
    await room.flush()
    const z = new StrictClient(room, 'zombie')
    await z.join()
    await room.flush()
    a.pump()
    // z's connection dies without a close: every send to it throws, and it stays listed
    z.ws.dead = true
    // people come and go: each is a who-is-here message
    for (let i = 0; i < 5; i++) {
      const v = new StrictClient(room, `v${i}`)
      await v.join().catch(() => {})
      await room.flush()
      await room.drop(v.ws)
      await room.flush()
    }
    a.pump()
    expect(bufferGaps(room)).toEqual([])
    const late = new StrictClient(room, 'late')
    await late.join()
    await room.flush()
    late.pump()
    a.pump()
    expect(late.seq).toBe(a.seq)
  })

  it('a message someone sends still reaches the others and stays in the buffer', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    const z = new StrictClient(room, 'zombie')
    await a.join()
    await z.join()
    await room.flush()
    z.ws.dead = true
    for (let i = 0; i < 5; i++) await room.send(a.ws, `m${i}`)
    a.pump()
    expect(bufferGaps(room)).toEqual([])
    expect(a.history.filter((h) => h.endsWith('m4')).length).toBe(1)
  })
})

/** The Palace's room as the live reflector hands it out: a snapshot, messages after it, a hole, messages after the hole. */
async function brokenRoom({ sameTick = false } = {}) {
  const room = await makeRoom()
  const a = new StrictClient(room, 'a')
  await a.join()
  await room.flush()
  for (let i = 0; i < 6; i++) await room.send(a.ws, `before-snapshot${i}`)
  a.pump()
  await a.snapshot()
  // time goes on after the snapshot, as it always does while a client is connected (a tick every 50 ms); `sameTick`
  // is the one case where it doesn't: everything after the snapshot within its very tick
  if (!sameTick) await room.flush(120)
  for (let i = 0; i < 8; i++) await room.send(a.ws, `kept${i}`)
  if (!sameTick) await room.flush(120)
  a.pump()
  // the hole: numbers given out, messages never buffered (what the unguarded send did)
  const s = room.state()
  s.seq = (s.seq + 40) >>> 0
  for (let i = 0; i < 3; i++) {
    s.seq = (s.seq + 1) >>> 0
    s.messages.push([s.time + i + 1, s.seq, 'after-hole'])
  }
  await room.sync.ctx.storage.put('state', s)
  return { room, a }
}

describe('a room whose buffer already has a hole', () => {
  it('nobody inside (after a deploy): the next joiner gets in', async () => {
    const { room } = await brokenRoom()
    await room.restart({ dropSockets: true })
    expect(bufferGaps(room).length).toBe(1)
    const b = new StrictClient(room, 'b')
    await b.join()
    await room.flush()
    b.pump()
    expect(bufferGaps(room)).toEqual([])
    const c = new StrictClient(room, 'c')
    await c.join()
    await room.flush()
    await room.send(b.ws, 'after-heal')
    b.pump()
    c.pump()
    expect(c.seq).toBe(b.seq)
    expect(c.history).toEqual(b.history)
    expect(faults()).toEqual([expect.stringContaining('Nobody is in')])
  })

  it('a client that was in the room before, coming back later, never keeps a model the others do not have', async () => {
    const { room, a } = await brokenRoom()
    // a ran everything up to the hole and was disconnected by the deploy, its model kept
    const aHistory = [...a.history]
    await room.restart({ dropSockets: true })
    const b = new StrictClient(room, 'b')
    await b.join()
    await room.flush()
    // b works on: enough new messages that the room's number passes where a's model stands
    for (let i = 0; i < 60; i++) await room.send(b.ws, `new${i}`)
    b.pump()
    // a's page reconnects with the model it kept
    await a.rejoin()
    await room.flush()
    await room.send(b.ws, 'together')
    a.pump()
    b.pump()
    expect(a.seq).toBe(b.seq)
    // whatever a did (seamless or from the snapshot), its model must now be b's
    expect(a.history, `a kept ${aHistory.length} old messages`).toEqual(b.history)
  })

  it('the same, for a client cut off within the very tick of the snapshot (the one case a reconnect can be seamless)', async () => {
    const { room, a } = await brokenRoom({ sameTick: true })
    await room.restart({ dropSockets: true })
    const b = new StrictClient(room, 'b')
    await b.join()
    await room.flush()
    for (let i = 0; i < 60; i++) await room.send(b.ws, `new${i}`)
    b.pump()
    await a.rejoin()
    await room.flush()
    await room.send(b.ws, 'together')
    a.pump()
    b.pump()
    // the healed room is a new timeline, so even here the client loads the snapshot
    expect(a.lastSync).toBe('reboot')
    expect(a.history).toEqual(b.history)
  })

  it('people playing inside are never thrown out for a joiner: they are asked for a snapshot, and with it the joiner gets in', async () => {
    const { room, a } = await brokenRoom()
    // (no restart: a is still connected and holds the session as it really is, the hole's messages too)
    a.seq = room.state().seq
    a.time = room.state().time + 10
    const before = { seq: room.state().seq, messages: room.state().messages.length, timeline: room.state().timeline }
    const b = new StrictClient(room, 'b')
    await expect(b.join()).rejects.toThrow(/Expected message/)
    await room.drop(b.ws)
    await room.flush()
    // nothing of the session was thrown away, and a goes on
    expect(room.state().timeline).toBe(before.timeline)
    expect(room.state().messages.length).toBeGreaterThanOrEqual(before.messages)
    await room.send(a.ws, 'still playing')
    expect(() => a.pump()).not.toThrow()
    // a was asked for a snapshot; once it announces one the buffer is whole again
    expect(a.ws.frames.some((f) => f.action === 'REQU')).toBe(true)
    await a.snapshot()
    expect(bufferGaps(room)).toEqual([])
    const c = new StrictClient(room, 'c')
    await c.join()
    await room.flush()
    await room.send(a.ws, 'together')
    a.pump()
    c.pump()
    expect(c.seq).toBe(a.seq)
    expect(faults()).toEqual([expect.stringContaining('left as it is')])
  })

  it('a connection that is gone but still listed is nobody: the room is healed past it', async () => {
    const { room, a } = await brokenRoom()
    // a's page is long gone: the runtime still lists its socket, and it last said something over a minute ago
    a.ws.dead = true
    await room.flush(61_000)
    const b = new StrictClient(room, 'b')
    await b.join()
    await room.flush()
    b.pump()
    expect(bufferGaps(room)).toEqual([])
    expect(faults()).toEqual([expect.stringContaining('Nobody is in')])
  })
})

/** Every shape the unguarded send could leave: numbers given out, messages never buffered. */
async function roomWith(shape: 'inner' | 'tail' | 'tail-fresh' | 'head-empty' | 'head') {
  const room = await makeRoom()
  const a = new StrictClient(room, 'a')
  await a.join()
  await room.flush()
  for (let i = 0; i < 4; i++) await room.send(a.ws, `m${i}`)
  a.pump()
  if (shape !== 'tail-fresh') {
    await a.snapshot()
    await room.flush(120)
  }
  const s = room.state()
  const lose = (n: number) => (s.seq = (s.seq + n) >>> 0)
  const add = (n: number) => {
    for (let i = 0; i < n; i++) {
      s.seq = (s.seq + 1) >>> 0
      s.messages.push([s.time + 1, s.seq, 'kept'])
    }
  }
  if (shape === 'tail' || shape === 'tail-fresh') {
    add(3)
    lose(5)
  } else if (shape === 'head-empty') lose(5)
  else if (shape === 'head') {
    lose(5)
    add(3)
  } else {
    add(3)
    lose(5)
    add(3)
  }
  await room.sync.ctx.storage.put('state', s)
  await room.restart({ dropSockets: true })
  return room
}

describe('every shape of a damaged buffer', () => {
  for (const shape of ['inner', 'tail', 'tail-fresh', 'head-empty', 'head'] as const) {
    it(`${shape}: the first page to come gets in, on a new timeline, and the next one too`, async () => {
      const room = await roomWith(shape)
      const was = room.state().timeline
      const b = new StrictClient(room, 'b')
      await b.join()
      await room.flush()
      await room.send(b.ws, 'hello')
      b.pump()
      expect(room.state().timeline).not.toBe(was)
      expect(bufferGaps(room)).toEqual([])
      const c = new StrictClient(room, 'c')
      await c.join()
      await room.flush()
      await room.send(b.ws, 'again')
      b.pump()
      c.pump()
      expect(c.seq).toBe(b.seq)
      expect(c.history).toEqual(b.history)
      expect(faults().length).toBe(1)
    })
  }
})

describe('bufferFault', () => {
  const m = (...seqs: number[]) => seqs.map((q) => [0, q, 'x'])
  const I = 0xfffffff0 >>> 0
  it('takes a buffer a joiner can replay', () => {
    expect(bufferFault([], 10, 10)).toBeNull()
    expect(bufferFault(m(11, 12, 13), 10, 13)).toBeNull()
    // a fresh session, and the numbers wrapping round
    expect(bufferFault([], I, I)).toBeNull()
    expect(bufferFault(m(I + 1, I + 2), I, I + 2)).toBeNull()
    expect(bufferFault(m(0xffffffff, 0, 1), 0xfffffffe, 1)).toBeNull()
    // a head a snapshot hasn't purged yet (a join that raced the snapshot's save)
    expect(bufferFault(m(8, 9, 10, 11, 12), 10, 12)).toBeNull()
    expect(bufferFault(m(8, 9, 10), 10, 10)).toBeNull()
  })
  it('names what is wrong with one it cannot', () => {
    expect(bufferFault(m(11, 12, 20, 21), 10, 21)).toMatch(/gap/)
    expect(bufferFault(m(11, 12), 10, 17)).toMatch(/last buffered/)
    expect(bufferFault([], 10, 15)).toMatch(/nothing buffered/)
    expect(bufferFault(m(16, 17), 10, 17)).toMatch(/first buffered/)
    expect(bufferFault(m(8, 9), 10, 15)).toMatch(/nothing buffered/)
    expect(bufferFault(m(I + 3), I, I + 3)).toMatch(/first buffered/)
  })
})

describe('storage that refuses a write', () => {
  it('a message is still delivered and buffered while the write fails', async () => {
    const room = await makeRoom()
    const a = new StrictClient(room, 'a')
    await a.join()
    await room.flush()
    room.putFails = true
    for (let i = 0; i < 5; i++) await room.send(a.ws, `m${i}`).catch(() => {})
    a.pump()
    expect(a.history.filter((h) => /:m\d$/.test(h)).length).toBe(5)
    expect(bufferGaps(room)).toEqual([])
  })
})

/** A seeded run of joins, sends, drops, dead connections and snapshots: whatever happens, no hole, and everyone alive agrees. */
describe('random play', () => {
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  for (let seed = 1; seed <= 120; seed++) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed)
      const room = await makeRoom()
      let alive: StrictClient[] = []
      let n = 0
      const problems: string[] = []
      const pumpAll = () => {
        for (const c of [...alive]) {
          try {
            c.pump()
          } catch (err) {
            problems.push(`${c.name}: ${(err as Error).message}`)
            alive = alive.filter((x) => x !== c)
          }
        }
      }
      for (let step = 0; step < 120; step++) {
        const p = r()
        if (alive.length === 0 || p < 0.18) {
          const c = new StrictClient(room, `c${n++}`)
          try {
            await c.join()
            alive.push(c)
          } catch (err) {
            problems.push(`join ${c.name}: ${(err as Error).message}`)
          }
        } else if (p < 0.7) {
          const c = alive[Math.floor(r() * alive.length)]!
          await room.send(c.ws, `s${step}`).catch(() => {})
        } else if (p < 0.8) {
          const c = alive[Math.floor(r() * alive.length)]!
          alive = alive.filter((x) => x !== c)
          await room.drop(c.ws)
        } else if (p < 0.88) {
          // a connection dies without a close and stays listed for a while
          const c = alive[Math.floor(r() * alive.length)]!
          alive = alive.filter((x) => x !== c)
          c.ws.dead = true
        } else if (p < 0.94) {
          const c = alive[Math.floor(r() * alive.length)]!
          pumpAll()
          if (alive.includes(c)) await c.snapshot()
        } else if (p < 0.97) {
          // every dead connection is finally closed by the runtime
          for (const s of room.sockets) if (s.dead && !s.closed) await room.drop(s)
        } else {
          // the object is evicted and made again from what it stored, its sockets kept (hibernation)
          await room.restart()
        }
        await room.flush(r() < 0.5 ? 10 : 250)
        pumpAll()
      }
      await room.flush()
      pumpAll()
      const late = new StrictClient(room, 'late')
      try {
        await late.join()
        await room.flush()
        late.pump()
        alive.push(late)
      } catch (err) {
        problems.push(`late: ${(err as Error).message}`)
      }
      pumpAll()
      expect(problems).toEqual([])
      expect(bufferGaps(room)).toEqual([])
      // nothing here ever damages the buffer, so nothing may ever be taken for damage (a heal would cost a room its state)
      expect(faults()).toEqual([])
      const seqs = new Set(alive.map((c) => c.seq))
      expect(seqs.size).toBe(1)
    })
  }
})
