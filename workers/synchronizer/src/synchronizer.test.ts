import { describe, it, expect } from 'vitest'
import { Synchronizer } from './synchronizer'
import type { Env } from './types'

/** A DO state with `sockets` connected clients and nothing stored. */
function makeDo(sockets = 0) {
  const ctx = {
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
    storage: { get: async () => undefined, put: async () => {} },
    getWebSockets: () => Array.from({ length: sockets }, () => ({})),
    id: { toString: () => 'do-id' },
  }
  const env = { MAX_CLIENTS_PER_SESSION: '100' } as unknown as Env
  return new Synchronizer(ctx as never, env)
}

describe('Synchronizer inspection routes', () => {
  it('serves /health, /info, /snapshots and /requ only at their exact paths, without an upgrade', async () => {
    const sync = makeDo()
    const health = await sync.fetch(new Request('https://do/health'))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', clients: 0 })
    // /requ with nobody connected: the route answers, with nothing to send to
    expect((await sync.fetch(new Request('https://do/requ', { method: 'POST' }))).status).toBe(404)
  })

  it('never serves them for a path that only ends like one', async () => {
    const sync = makeDo()
    for (const path of ['/v1/abc/health', '/v1/abc/info', '/v1/abc/snapshots', '/reflector/abc/requ']) {
      const res = await sync.fetch(new Request(`https://do${path}`, { method: path.endsWith('requ') ? 'POST' : 'GET' }))
      expect(res.status).toBe(426) // Expected WebSocket
    }
  })

  it('treats a WebSocket upgrade as a join, whatever its path', async () => {
    // A full session refuses before any socket is made, which shows the join branch was taken
    const sync = makeDo(100)
    for (const path of ['/health', '/info', '/v1/abc/snapshots', '/v1/abc/requ']) {
      const res = await sync.fetch(new Request(`https://do${path}`, { headers: { Upgrade: 'websocket' } }))
      expect(res.status).toBe(503)
      expect(await res.text()).toBe('Session full')
    }
  })
})
