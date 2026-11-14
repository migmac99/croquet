import { describe, it, expect } from 'vitest'
import { checkAdmin, timingSafeEqualText, bearerOf, adminHeaders } from './admin-auth'

const req = (headers: Record<string, string> = {}) => new Request('https://x/', { headers })

describe('admin auth', () => {
  it('compares tokens by value', async () => {
    expect(await timingSafeEqualText('abc', 'abc')).toBe(true)
    expect(await timingSafeEqualText('abc', 'abd')).toBe(false)
    expect(await timingSafeEqualText('abc', 'abcd')).toBe(false)
    expect(await timingSafeEqualText('', '')).toBe(true)
  })

  it('reads a bearer token', () => {
    expect(bearerOf(req({ Authorization: 'Bearer t1' }))).toBe('t1')
    expect(bearerOf(req({ Authorization: 'bearer  t1 ' }))).toBe('t1')
    expect(bearerOf(req({ Authorization: 't1' }))).toBeNull()
    expect(bearerOf(req())).toBeNull()
  })

  it('checks a request', async () => {
    expect(await checkAdmin(req({ Authorization: 'Bearer s' }), 's')).toBe('ok')
    expect(await checkAdmin(req({ Authorization: 'Bearer t' }), 's')).toBe('wrong')
    expect(await checkAdmin(req(), 's')).toBe('missing')
    expect(await checkAdmin(req({ Authorization: 'Bearer ' }), '')).toBe('unconfigured')
    expect(await checkAdmin(req({ Authorization: 'Bearer s' }), undefined)).toBe('unconfigured')
  })

  it('sends nothing when no token is set', () => {
    expect(adminHeaders(undefined)).toEqual({})
    expect(adminHeaders('s')).toEqual({ Authorization: 'Bearer s' })
  })
})
