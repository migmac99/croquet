/**
 * Admin authentication between the synchronizer and the tools that inspect it.
 *
 * The synchronizer's inspection and control routes (session details, the R2
 * session list, the manual snapshot request) answer only a caller that sends
 * `Authorization: Bearer <SYNQ_ADMIN_TOKEN>`. The token is a Worker secret set
 * on both the synchronizer and the manager (`wrangler secret put SYNQ_ADMIN_TOKEN`);
 * locally it goes in each worker's `.dev.vars`. Without it the routes are closed.
 */

/** The name of the Worker secret both workers read. */
export const ADMIN_TOKEN_SECRET = 'SYNQ_ADMIN_TOKEN'

export type AdminCheck = 'ok' | 'unconfigured' | 'missing' | 'wrong'

/** The bearer token a request carries, or null. */
export function bearerOf(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/**
 * Compare two strings in constant time: both are hashed first, so neither the
 * length nor the first differing character shows in the time taken.
 */
export async function timingSafeEqualText(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))])
  const va = new Uint8Array(ha)
  const vb = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}

/** Whether a request carries the admin token. An unset or empty secret refuses everyone. */
export async function checkAdmin(request: Request, secret: string | undefined): Promise<AdminCheck> {
  if (!secret) return 'unconfigured'
  const sent = bearerOf(request)
  if (!sent) return 'missing'
  return (await timingSafeEqualText(sent, secret)) ? 'ok' : 'wrong'
}

/** The headers a trusted caller sends with an admin request. */
export function adminHeaders(secret: string | undefined): Record<string, string> {
  return secret ? { Authorization: `Bearer ${secret}` } : {}
}
