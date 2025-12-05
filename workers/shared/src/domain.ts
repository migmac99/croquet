/**
 * Domain matching utilities for API key validation
 */

/**
 * Match domain against pattern (supports wildcards)
 * Protocols in patterns are stripped automatically (e.g., "https://example.com" -> "example.com")
 * @example
 *   matchDomain("example.com", "example.com")        // true - exact match
 *   matchDomain("example.com", "https://example.com") // true - protocol stripped
 *   matchDomain("sub.example.com", "*.example.com")  // true - subdomain wildcard
 *   matchDomain("anything.com", "*")                 // true - wildcard all
 *   matchDomain("localhost", "localhost")            // true - exact match
 *   matchDomain("localhost:3000", "localhost:*")     // true - port wildcard
 */
export function matchDomain(domain: string, pattern: string): boolean {
  // Normalize pattern: strip protocol if present (e.g., "https://example.com" -> "example.com")
  let normalizedPattern = pattern
  if (pattern.includes('://')) {
    try {
      normalizedPattern = new URL(pattern).hostname
    } catch {
      // If URL parsing fails, try simple string extraction
      normalizedPattern = pattern.replace(/^https?:\/\//, '').split('/')[0]
    }
  }

  if (normalizedPattern === domain) return true
  if (normalizedPattern === '*') return true

  // Port wildcard (localhost:*)
  if (normalizedPattern.endsWith(':*')) {
    const base = normalizedPattern.slice(0, -2)
    return domain === base || domain.startsWith(base + ':')
  }

  // Subdomain wildcard (*.example.com)
  if (normalizedPattern.startsWith('*.')) {
    const baseDomain = normalizedPattern.slice(2)
    return domain === baseDomain || domain.endsWith('.' + baseDomain)
  }

  return false
}

/**
 * Check if an origin is allowed based on allowed domains list
 * Handles null origin (file:// URLs) by checking for localhost permission
 */
export function isOriginAllowed(origin: string | null, allowedDomains: string[]): { allowed: boolean; error?: string } {
  if (!origin || allowedDomains.length === 0) return { allowed: true }

  // Handle null origin (file:// URLs) - allow if localhost is permitted
  if (origin === 'null') {
    const allowsLocal = allowedDomains.some((d) => d === 'localhost' || d === 'localhost:*' || d === '*')
    if (!allowsLocal) {
      return {
        allowed: false,
        error: 'Local file access not allowed for this API key (add localhost to allowed domains)',
      }
    }
    return { allowed: true }
  }

  // Parse origin and check against allowed domains
  try {
    const originHost = new URL(origin).hostname
    const allowed = allowedDomains.some((pattern) => matchDomain(originHost, pattern))
    if (!allowed) return { allowed: false, error: `Domain '${originHost}' not allowed for this API key` }
    return { allowed: true }
  } catch {
    return { allowed: false, error: 'Invalid origin' }
  }
}

/**
 * Get origin from request headers (Origin or Referer)
 */
export function getOrigin(request: Request): string | null {
  return request.headers.get('Origin') || request.headers.get('Referer')
}
