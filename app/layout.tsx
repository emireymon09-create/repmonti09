import './globals.css'
import type { Metadata, Viewport } from 'next'
import { ServiceWorker } from '@/components/ServiceWorker'
import { THEME_BOOT_SCRIPT } from '@/lib/themeBoot'
import { LANG_BOOT_SCRIPT } from '@/lib/i18n/boot'
import { VIEWPORT_BOOT_SCRIPT } from '@/lib/viewportBoot'
import { VIEWPORT_DEBUG_SCRIPT } from '@/lib/viewportDebug'
import { I18nProvider } from '@/lib/i18n/react'

export const metadata: Metadata = {
  title: 'Amelia',
  description: 'Baby tracking for the Family Hub',
  applicationName: 'Amelia',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    // iOS has no manifest support worth relying on; these are what make
    // "Add to Home Screen" open without Safari chrome.
    capable: true,
    title: 'Amelia',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  // The wall screen runs a kiosk browser; a stray pinch-zoom there is a
  // support call, and on a phone the 16px input floor already prevents
  // the zoom-on-focus this would otherwise guard against.
  width: 'device-width',
  initialScale: 1,
  // Lay out edge to edge, under the notch and the home indicator; the
  // stylesheet pads back in with env(safe-area-inset-*). Without this the
  // insets always read 0 and that padding never happens.
  viewportFit: 'cover',
  themeColor: '#211D1B',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot scripts set data-theme and lang on
    // <html> before React hydrates, so those attributes legitimately differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: LANG_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: VIEWPORT_BOOT_SCRIPT }} />
        {/* Instrumento temporal de la rama `diagnostico-viewport`: sin la
            bandera no hace nada (ni listeners, ni timers, ni DOM). Va DESPUÉS
            del boot para poder leer el `--vh-full` que ese script escribió. */}
        <script dangerouslySetInnerHTML={{ __html: VIEWPORT_DEBUG_SCRIPT }} />
      </head>
      <body>
        <I18nProvider>{children}</I18nProvider>
        <ServiceWorker />
      </body>
    </html>
  )
}
