import { execFileSync } from 'node:child_process'
import {
  createECDH,
  createDecipheriv,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, Agent, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

/**
 * Un servicio de push FALSO en 127.0.0.1, para probar el envío de punta a punta
 * sin FCM/Mozilla/Apple: recibe lo que manda lib/push/server.ts (vía web-push),
 * verifica el VAPID (RFC 8292) y DESCIFRA el contenido (aes128gcm, RFC 8291)
 * con las claves privadas del "navegador" suscripto. Si el cifrado o la firma
 * estuvieran mal, el test lo ve.
 *
 * Es https con un certificado autofirmado de un día (openssl), porque web-push
 * solo habla https y la base exige `endpoint ~ '^https://'`. El servidor de la
 * app confía en él solo porque el test le pasa el agente con ese CA
 * (setPushTransportForTests, que tira fuera de NODE_ENV === 'test').
 */

export type Browser = {
  /** Lo que el navegador le daría a la app: PushSubscription.toJSON(). */
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  /** Descifra un cuerpo aes128gcm dirigido a este navegador. */
  decrypt: (body: Buffer) => string
}

export type Received = {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

export type FakePushService = {
  origin: string
  agent: Agent
  received: Received[]
  /** Status a responder por path (default 201). */
  statusFor: Map<string, number>
  browser: (path: string) => Browser
  close: () => Promise<void>
}

export async function startFakePushService(): Promise<FakePushService> {
  const dir = mkdtempSync(join(tmpdir(), 'amelia-fake-push-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  const key = readFileSync(join(dir, 'key.pem'))
  const cert = readFileSync(join(dir, 'cert.pem'))
  rmSync(dir, { recursive: true, force: true })

  const received: Received[] = []
  const statusFor = new Map<string, number>()
  const server: Server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = req.url ?? ''
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks) })
      res.statusCode = statusFor.get(path) ?? 201
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  const origin = `https://127.0.0.1:${port}`

  return {
    origin,
    agent: new Agent({ ca: cert }),
    received,
    statusFor,
    browser: (path) => makeBrowser(`${origin}${path}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** Un "navegador" con claves de verdad (P-256 + 16 bytes de auth). */
function makeBrowser(endpoint: string): Browser {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const uaPublic = ecdh.getPublicKey()
  const authSecret = randomBytes(16)
  return {
    subscription: {
      endpoint,
      keys: { p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') },
    },
    decrypt(body) {
      // RFC 8188 §2.1: salt(16) | rs(4) | idlen(1) | keyid(idlen) | registro.
      const salt = body.subarray(0, 16)
      const idlen = body[20]
      const asPublic = body.subarray(21, 21 + idlen)
      const record = body.subarray(21 + idlen)
      // RFC 8291 §3.3-3.4.
      const ecdhSecret = ecdh.computeSecret(asPublic)
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
      const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
      const cek = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
      )
      const nonce = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
      )
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(record.subarray(record.length - 16))
      const plain = Buffer.concat([
        decipher.update(record.subarray(0, record.length - 16)),
        decipher.final(),
      ])
      // Relleno: el último byte distinto de cero tiene que ser el delimitador 0x02.
      let end = plain.length - 1
      while (end >= 0 && plain[end] === 0) end -= 1
      if (plain[end] !== 0x02)
        throw new Error('padding delimiter is not 0x02 (not the last record)')
      return plain.subarray(0, end).toString('utf8')
    },
  }
}

/**
 * Verifica `Authorization: vapid t=<JWT>, k=<clave pública>` (RFC 8292):
 * firma ES256 válida con esa clave, `aud` = origen del endpoint, `exp` futuro
 * y no más de 24 h, `sub` el esperado. Devuelve los claims.
 */
export function verifyVapid(
  header: string | string[] | undefined,
  expected: { publicKey: string; audience: string; subject: string },
): Record<string, unknown> {
  const m = String(header ?? '').match(/^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/)
  if (!m) throw new Error(`not a vapid Authorization header: ${String(header)}`)
  const [, jwt, k] = m
  if (k !== expected.publicKey) throw new Error('k is not our VAPID public key')
  const [head, payload, sig] = jwt.split('.')
  const raw = Buffer.from(k, 'base64url')
  const pub = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  })
  const ok = verify(
    'sha256',
    Buffer.from(`${head}.${payload}`),
    { key: pub, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sig, 'base64url'),
  )
  if (!ok) throw new Error('VAPID JWT signature does not verify')
  const header64 = JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string }
  if (header64.alg !== 'ES256') throw new Error(`alg ${header64.alg}`)
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    aud: string
    exp: number
    sub: string
  }
  const now = Math.floor(Date.now() / 1000)
  if (claims.aud !== expected.audience) throw new Error(`aud ${claims.aud}`)
  if (claims.sub !== expected.subject) throw new Error(`sub ${claims.sub}`)
  if (!(claims.exp > now && claims.exp <= now + 24 * 3600)) throw new Error(`exp ${claims.exp}`)
  return claims
}

/** Un par VAPID fresco, en el formato de las variables de entorno. */
export function freshVapid(): { publicKey: string; privateKey: string; subject: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const priv = ecdh.getPrivateKey()
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: Buffer.concat([Buffer.alloc(32 - priv.length), priv]).toString('base64url'),
    subject: 'mailto:test@amelia.test',
  }
}
