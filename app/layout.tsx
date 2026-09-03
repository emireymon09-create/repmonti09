import './globals.css'
import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'Amelia',
  description: 'Baby tracking for the Family Hub',
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
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
