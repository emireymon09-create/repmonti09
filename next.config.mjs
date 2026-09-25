/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          // La pantalla de pared no necesita nada de esto, y el teléfono
          // menos todavía: la regla de la casa es que no sale media.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ]
  },
}

// CSP queda FUERA a propósito: Next (14 y 15 igual) inyecta estilos y scripts
// inline, y una
// CSP mal puesta rompe la app en la pared sin que nadie mire la consola. Va
// como trabajo aparte, con report-only primero.

export default nextConfig
