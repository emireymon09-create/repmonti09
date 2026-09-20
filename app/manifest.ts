import type { MetadataRoute } from 'next'
import { color } from '@/lib/tokens'

/**
 * Installed-app metadata.
 *
 * Two very different install targets:
 *   · Emilio's and Ana's phones — added to the home screen, opened
 *     one-handed at 3am, often on bad nursery wifi.
 *   · The 27" wall screen — a kiosk browser that should come up in the
 *     app and stay there, with no browser chrome to tap out of.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Amelia',
    short_name: 'Amelia',
    description: 'Feeding, nursing, diapers, sleep and growth for Amelia.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: color.bg,
    theme_color: color.bg,
    categories: ['health', 'lifestyle'],
    icons: [
      { src: '/icons/icon-48.png', sizes: '48x48', type: 'image/png' },
      { src: '/icons/icon-72.png', sizes: '72x72', type: 'image/png' },
      { src: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
      { src: '/icons/icon-144.png', sizes: '144x144', type: 'image/png' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-256.png', sizes: '256x256', type: 'image/png' },
      { src: '/icons/icon-384.png', sizes: '384x384', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Android crops to whatever shape the launcher uses; this one
      // fills edge to edge with the mark inside the safe zone.
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      { name: 'Milk', url: '/pumping' },
      { name: 'Growth', url: '/growth' },
      { name: 'Doctor', url: '/appointments' },
    ],
  }
}
