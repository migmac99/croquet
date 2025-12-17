/**
 * Utility Functions
 *
 * General-purpose helpers used across the synchronizer.
 */

// ============================================================================
// Base64 Encoding/Decoding
// ============================================================================

/** Convert ArrayBuffer to Base64 string */
export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** Convert Base64 string to ArrayBuffer */
export const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// ============================================================================
// Cloudflare Location Detection
// ============================================================================

/**
 * Detect DO location by fetching cloudflare.com/cdn-cgi/trace
 * The colo field indicates which datacenter the request exits from.
 *
 * Response format:
 * fl=123...
 * h=cloudflare.com
 * colo=SFO
 * ...
 */
export const detectColoFromTrace = async (traceUrl = 'https://1.1.1.1/cdn-cgi/trace'): Promise<string | null> => {
  try {
    const response = await fetch(traceUrl)
    if (!response.ok) return null

    const text = await response.text()
    const match = text.match(/^colo=([A-Z]{3})$/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// ============================================================================
// Message Size Calculation
// ============================================================================

/** Add _size property to payload for accounting (matches original reflector) */
export const addPayloadSize = <T extends Record<string, unknown>>(payload: T): T & { _size: number } => {
  ;(payload as T & { _size: number })._size = JSON.stringify(payload).length
  return payload as T & { _size: number }
}

// ============================================================================
// Client Filtering Helpers
// ============================================================================

/** Filter active WebSockets from a list */
export const filterActiveSockets = <T extends { deserializeAttachment: () => unknown }>(sockets: T[], isActive: (att: unknown) => boolean): T[] =>
  sockets.filter((ws) => isActive(ws.deserializeAttachment()))

/** Count active clients from WebSockets */
export const countActiveClients = <T extends { deserializeAttachment: () => unknown }>(sockets: T[], isActive: (att: unknown) => boolean): number =>
  sockets.filter((ws) => isActive(ws.deserializeAttachment())).length
