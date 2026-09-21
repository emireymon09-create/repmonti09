import pkg from '@/package.json'

/**
 * La versión de la app: el campo "version" de package.json (mismo patrón que
 * fruco-erp, apps/web/src/version.ts). El historial está en CHANGELOG.md.
 */
export const APP_VERSION: string = pkg.version
