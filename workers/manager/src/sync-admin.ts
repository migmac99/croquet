/**
 * Calls from the manager to the synchronizer's admin routes.
 */
import { adminHeaders } from '@croquet/worker-shared'
import type { Env } from './types'

/** Check if a string looks like a URL with a ws/wss/http/https protocol. */
function isValidUrl(url: string | undefined): boolean {
  if (!url) return false
  return /^(ws|wss|http|https):\/\//.test(url)
}

/** The http(s) origin of a ws(s)/http(s) URL, or null. */
function httpOriginOf(url: string | undefined): string | null {
  if (!isValidUrl(url)) return null
  try {
    return new URL(url!.replace(/^ws/, 'http')).origin
  } catch {
    return null
  }
}

/**
 * Fetch one of the synchronizer's admin routes (/session/*, /sessions/r2).
 * The admin token goes only to the synchronizer this manager is configured for
 * (SYNCHRONIZER_URL), never to a URL a session record names elsewhere.
 */
export function syncAdminFetch(env: Pick<Env, 'SYNCHRONIZER_URL' | 'SYNQ_ADMIN_TOKEN'>, url: string, init: RequestInit = {}): Promise<Response> {
  const ours = httpOriginOf(env.SYNCHRONIZER_URL)
  const target = httpOriginOf(url)
  const headers = new Headers(init.headers)
  if (ours && target === ours) for (const [k, v] of Object.entries(adminHeaders(env.SYNQ_ADMIN_TOKEN))) headers.set(k, v)
  return fetch(url, { ...init, headers })
}
