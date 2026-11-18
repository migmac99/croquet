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
import { bufferGaps, makeRoom, StrictClient } from '../test/room'

const quiet = () => {
  for (const k of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, k).mockImplementation(() => {})
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 })
  quiet()
})
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

  it('a client active inside when someone joins: the joiner gets in, the other drops once and both end on one model', async () => {
    const { room, a } = await brokenRoom()
    // (no restart: a is still connected and has run everything, the hole's messages too as far as it knows)
    a.seq = room.state().seq
    a.time = room.state().time + 10
    const b = new StrictClient(room, 'b')
    let bJoined = true
    await b.join().catch(() => (bJoined = false))
    await room.flush()
    b.pump()
    // the joiner is in; the client that was inside is told a number it doesn't expect on the next message and drops,
    // as the vendored client does (it closes with an error and joins again)
    expect(bJoined).toBe(true)
    await room.send(b.ws, 'x')
    expect(() => a.pump()).toThrow(/Expected message/)
    await room.drop(a.ws)
    await a.rejoin()
    await room.flush()
    await room.send(b.ws, 'together')
    a.pump()
    b.pump()
    // it comes back on the room's new timeline, from the snapshot, on the same model as the joiner
    expect(a.lastSync).toBe('reboot')
    expect(a.seq).toBe(b.seq)
    expect(a.history).toEqual(b.history)
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
      const seqs = new Set(alive.map((c) => c.seq))
      expect(seqs.size).toBe(1)
    })
  }
})
