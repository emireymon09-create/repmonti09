// Genera un par de claves VAPID (Web Push, RFC 8292) para ESTA máquina y las
// imprime como líneas de .env. Lo llama `pnpm db:env` solo para las variables
// que falten en .env.local: nunca pisa una clave existente, porque cambiarla
// deja muertas todas las suscripciones que ya hay (el navegador se suscribió
// con la pública vieja).
//
// P-256 pelado con node:crypto — el mismo formato que `web-push
// generate-vapid-keys`: pública sin comprimir (65 bytes) y privada (32 bytes),
// las dos en base64url.
import { createECDH } from 'node:crypto'

const ecdh = createECDH('prime256v1')
ecdh.generateKeys()
// Siempre 32 bytes: si la privada empieza con ceros, web-push la rechaza corta.
const priv = ecdh.getPrivateKey()
const privateKey = Buffer.concat([Buffer.alloc(32 - priv.length), priv])

process.stdout.write(
  [
    `NEXT_PUBLIC_VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}`,
    `VAPID_PRIVATE_KEY=${privateKey.toString('base64url')}`,
    // Contacto que el servicio de push (FCM, Mozilla, Apple) ve en cada envío.
    // En producción, un mailto: real del que opera la app.
    'VAPID_SUBJECT=mailto:amelia-local@example.com',
    '',
  ].join('\n'),
)
