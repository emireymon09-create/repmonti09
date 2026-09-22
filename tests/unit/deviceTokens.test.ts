import { describe, expect, it } from 'vitest'
import {
  generateDeviceToken,
  hashDeviceToken,
  isDeviceScope,
  looksLikeDeviceToken,
  readBearer,
} from '@/lib/deviceTokens'

describe('generateDeviceToken', () => {
  it('da un token con prefijo y 256 bits, y su hash', () => {
    const { token, hash } = generateDeviceToken()
    expect(token).toMatch(/^amd_[A-Za-z0-9_-]{43}$/)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashDeviceToken(token))
  })

  it('dos tokens nunca salen iguales', () => {
    expect(generateDeviceToken().token).not.toBe(generateDeviceToken().token)
  })
})

describe('hashDeviceToken', () => {
  it('es determinístico y no contiene el token', () => {
    const t = 'amd_' + 'a'.repeat(43)
    expect(hashDeviceToken(t)).toBe(hashDeviceToken(t))
    expect(hashDeviceToken(t)).not.toContain('aaaa')
  })
})

describe('looksLikeDeviceToken', () => {
  it('acepta solo la forma exacta', () => {
    expect(looksLikeDeviceToken(generateDeviceToken().token)).toBe(true)
    expect(looksLikeDeviceToken('amd_corto')).toBe(false)
    expect(looksLikeDeviceToken('secreto-viejo-compartido')).toBe(false)
    expect(looksLikeDeviceToken(undefined)).toBe(false)
  })
})

describe('readBearer', () => {
  const req = (h?: string) =>
    new Request('http://x', h === undefined ? {} : { headers: { authorization: h } })

  it('lee el token de Authorization: Bearer', () => {
    expect(readBearer(req('Bearer amd_abc'))).toBe('amd_abc')
    expect(readBearer(req('bearer amd_abc'))).toBe('amd_abc')
  })

  it('sin header, o con otro esquema, no hay token', () => {
    expect(readBearer(req())).toBeNull()
    expect(readBearer(req('Basic abc'))).toBeNull()
    expect(readBearer(req('Bearer '))).toBeNull()
  })
})

describe('isDeviceScope', () => {
  it('solo los tres scopes que existen', () => {
    expect(isDeviceScope('ingest')).toBe(true)
    expect(isDeviceScope('quick_nurse')).toBe(true)
    expect(isDeviceScope('push_check')).toBe(true)
    expect(isDeviceScope('admin')).toBe(false)
  })
})
