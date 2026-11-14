import { describe, it, expect, vi, afterEach } from 'vitest'
import { syncAdminFetch } from './sync-admin'

afterEach(() => vi.unstubAllGlobals())

function capture() {
  const calls: Array<{ url: string; auth: string | null }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('Authorization') })
    return new Response('{}')
  })
  return calls
}

const env = { SYNCHRONIZER_URL: 'wss://synq.example', SYNQ_ADMIN_TOKEN: 'tok' }

describe('syncAdminFetch', () => {
  it('sends the admin token to the configured synchronizer', async () => {
    const calls = capture()
    await syncAdminFetch(env, 'https://synq.example/sessions/r2?limit=500')
    await syncAdminFetch({ ...env, SYNCHRONIZER_URL: 'ws://localhost:8787' }, 'http://localhost:8787/session/a/info')
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok', 'Bearer tok'])
  })

  it('never sends it anywhere else', async () => {
    const calls = capture()
    await syncAdminFetch(env, 'https://elsewhere.example/session/a/info')
    await syncAdminFetch(env, 'http://synq.example/session/a/info') // another origin (scheme)
    await syncAdminFetch({ ...env, SYNQ_ADMIN_TOKEN: undefined }, 'https://synq.example/sessions/r2')
    expect(calls.map((c) => c.auth)).toEqual([null, null, null])
  })
})
