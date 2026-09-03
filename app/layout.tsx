export const metadata = {
  title: 'Amelia',
  description: 'Family hub for Amelia',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#211D1B', color: '#EDE6D6', minHeight: '100vh' }}>
        {children}
      </body>
    </html>
  )
}
