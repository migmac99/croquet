import { describe, it, expect } from 'vitest'
import worker from './index'
import { sessionRoute } from './admin-routes'
import type { Env } from './types'

const TOKEN = 'test-admin-token-not-a-real-secret'
const ORIGIN = 'https://synq.example'

type Forwarded = { sessionName: string; url: string; method: string; headers: Headers }

/** A worker env on fakes: the DO namespace records what reaches each session's DO. */
function makeEnv(overrides: Partial<Env> = {}) {
  const forwarded: Forwarded[] = []
  const r2Objects = new Map<string, ArrayBuffer>()
  const env = {
    CLUSTER_LABEL: 'test-cluster',
    PROTOCOL_VERSION: 'v1',
    MAX_CLIENTS_PER_SESSION: '100',
    SNAPSHOT_INTERVAL_MS: '60000',
    SESSION_TIMEOUT_MS: '300000',
    SYNQ_ADMIN_TOKEN: TOKEN,
    SYNCHRONIZER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (req: Request) => {
          forwarded.push({ sessionName: id.name, url: req.url, method: req.method, headers: req.headers })
          return Response.json({ from: 'do', path: new URL(req.url).pathname })
        },
      }),
    },
    SNAPSHOTS: {
      list: async (opts: { prefix: string }) =>
        opts.prefix === 'sessions/'
          ? { delimitedPrefixes: ['sessions/abc/'], objects: [], truncated: false }
          : { objects: [{ uploaded: new Date(1000), customMetadata: { createdAt: '1234' } }], truncated: false },
      get: async (key: string) => {
        const body = r2Objects.get(key)
        return body ? { body, size: body.byteLength } : null
      },
      put: async (key: string, body: ArrayBuffer) => {
        r2Objects.set(key, body)
      },
    },
    ...overrides,
  } as unknown as Env
  return { env, forwarded, r2Objects }
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function call(env: Env, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx)
}

const admin = { Authorization: `Bearer ${TOKEN}` }

describe('/health', () => {
  it('says only ok, to anyone', async () => {
    const { env } = makeEnv()
    for (const path of ['/health', '/healthz']) {
      const res = await call(env, path)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'ok' })
    }
  })
})

describe('admin routes', () => {
  const routes: Array<{ path: string; method: string; doPath?: string }> = [
    { path: '/session/abc', method: 'GET', doPath: '/health' },
    { path: '/session/abc/info', method: 'GET', doPath: '/info' },
    { path: '/session/abc/snapshots', method: 'GET', doPath: '/snapshots' },
    { path: '/session/abc/requ', method: 'POST', doPath: '/requ' },
    { path: '/sessions/r2', method: 'GET' },
  ]

  for (const { path, method, doPath } of routes) {
    describe(`${method} ${path}`, () => {
      it('is refused without a token, and reaches no DO', async () => {
        const { env, forwarded } = makeEnv()
        const res = await call(env, path, { method })
        expect(res.status).toBe(401)
        expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
        expect(await res.json()).toEqual({ error: 'Missing admin token' })
        expect(forwarded).toEqual([])
      })

      it('is refused with a wrong token, and with a client API key in its place', async () => {
        const { env, forwarded } = makeEnv()
        for (const headers of <Record<string, string>[]>[
          { Authorization: `Bearer ${TOKEN}x` },
          { Authorization: 'Bearer ' },
          { Authorization: TOKEN },
          { 'X-Croquet-Auth': '3abc' },
        ]) {
          const res = await call(env, path, { method, headers })
          expect(res.status).toBe(401)
        }
        expect(forwarded).toEqual([])
      })

      it('is closed to everyone while no token is configured', async () => {
        const { env, forwarded } = makeEnv({ SYNQ_ADMIN_TOKEN: undefined })
        const res = await call(env, path, { method, headers: { Authorization: 'Bearer anything' } })
        expect(res.status).toBe(503)
        expect(forwarded).toEqual([])
      })

      it('answers with the token', async () => {
        const { env, forwarded } = makeEnv()
        const res = await call(env, path, { method, headers: admin })
        expect(res.status).toBe(200)
        if (doPath) {
          expect(await res.json()).toEqual({ from: 'do', path: doPath })
          expect(forwarded).toHaveLength(1)
          expect(forwarded[0].sessionName).toBe('abc')
          expect(new URL(forwarded[0].url).pathname).toBe(doPath)
          expect(forwarded[0].method).toBe(method)
          // The token stops at the worker: the DO never sees it
          expect(forwarded[0].headers.get('Authorization')).toBeNull()
        } else {
          expect(await res.json()).toEqual({
            sessions: [{ sessionId: 'abc', lastActivity: 1234, snapshotCount: 1 }],
            truncated: false,
          })
        }
      })
    })
  }

  it('refuses a wrong method or an unknown sub-route even with the token', async () => {
    const { env, forwarded } = makeEnv()
    expect((await call(env, '/session/abc/requ', { headers: admin })).status).toBe(405)
    expect((await call(env, '/session/abc/info', { method: 'POST', headers: admin })).status).toBe(405)
    expect((await call(env, '/session/abc/other', { headers: admin })).status).toBe(404)
    expect((await call(env, '/session/abc/info/more', { headers: admin })).status).toBe(404)
    expect((await call(env, '/sessions/r2', { method: 'POST', headers: admin })).status).toBe(405)
    expect(forwarded).toEqual([])
  })
})

describe('the client path still works without the admin token', () => {
  it('forwards a WebSocket join to the session DO, whatever its last segment', async () => {
    const { env, forwarded } = makeEnv()
    for (const path of ['/v1/abc', '/reflector/abc', '/v1/abc/info', '/v1/abc/requ']) {
      const res = await call(env, path, { headers: { Upgrade: 'websocket' } })
      expect(res.status).toBe(200) // the fake DO's answer
      const last = forwarded.at(-1)!
      expect(last.sessionName).toBe('abc')
      expect(new URL(last.url).pathname).toBe(path) // the original path: the DO serves it as a WebSocket
      expect(last.headers.get('Upgrade')).toBe('websocket')
      expect(last.headers.get('X-Session-Name')).toBe('abc')
    }
  })

  it('validates an API key on /join as before', async () => {
    const { env } = makeEnv()
    expect((await call(env, '/join', { headers: { 'X-Croquet-Auth': '3abc' } })).status).toBe(200)
    expect((await call(env, '/sign/join', {})).status).toBe(401)
  })

  it('uploads and downloads a snapshot file as before', async () => {
    const { env } = makeEnv()
    const signed = await call(env, '/files/app/s1/snap.bin', { headers: { 'X-Croquet-Auth': '3abc' } })
    expect(await signed.json()).toEqual({ read: `${ORIGIN}/files/app/s1/snap.bin`, write: `${ORIGIN}/files/app/s1/snap.bin` })
    expect((await call(env, '/files/app/s1/snap.bin', { method: 'PUT', body: new Uint8Array([1, 2, 3]) })).status).toBe(200)
    const got = await call(env, '/files/app/s1/snap.bin')
    expect(got.status).toBe(200)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('sessionRoute', () => {
  it('names the DO path, keeping the session id as written', () => {
    expect(sessionRoute(new URL(`${ORIGIN}/session/a%2Fb/info`), 'GET')).toEqual({ sessionId: 'a%2Fb', doPath: '/info' })
    expect(sessionRoute(new URL(`${ORIGIN}/session/`), 'GET')).toBeNull()
  })
})
