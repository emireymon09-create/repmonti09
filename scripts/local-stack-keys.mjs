// Genera los secretos del stack local de ESTA máquina. Nunca se commitean:
// el archivo que sale de acá (supabase/docker/.env) está en .gitignore.
//
// Las claves anon/service_role son JWT HS256 firmados con el JWT secret, que es
// exactamente lo que GoTrue y PostgREST validan. Diez años de vida: es un stack
// de desarrollo que escucha solo en 127.0.0.1.
import { createHmac, randomBytes } from 'node:crypto'

const jwtSecret = randomBytes(32).toString('hex')
const postgresPassword = randomBytes(24).toString('hex')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

function mint(role) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ role, iss: 'amelia-local', iat: now, exp: now + 10 * 365 * 86_400 })
  const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

process.stdout.write(
  [
    `JWT_SECRET=${jwtSecret}`,
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `ANON_KEY=${mint('anon')}`,
    `SERVICE_ROLE_KEY=${mint('service_role')}`,
    '',
  ].join('\n'),
)
