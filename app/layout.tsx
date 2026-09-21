import './globals.css'
import type { Metadata, Viewport } from 'next'
import { ServiceWorker } from '@/components/ServiceWorker'
import { THEME_BOOT_SCRIPT } from '@/lib/themeBoot'

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
  themeColor: '#211D1B',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script sets data-theme on <html>
    // before React hydrates, so the attribute legitimately differs.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  )
}
