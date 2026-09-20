// Este repo usa pnpm y solo pnpm. npm o yarn rompen el lockfile y dejan
// builds no reproducibles, que es justamente el hueco que esta migración
// cierra.
const ua = process.env.npm_config_user_agent ?? ''

if (!ua.startsWith('pnpm')) {
  console.error('\n  Este proyecto usa pnpm. Corré `pnpm install`.')
  console.error(`  Gestor detectado: ${ua || 'desconocido'}\n`)
  process.exit(1)
}
