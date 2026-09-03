'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    router.push('/dashboard')
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1 style={{ fontSize: 28, marginBottom: 24 }}>Amelia</h1>
      <form onSubmit={handleSubmit}>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={inputStyle}
        />
        <label style={{ display: 'block', fontSize: 12, margin: '12px 0 4px' }}>Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={inputStyle}
        />
        {error && <p style={{ color: '#B14C3A', fontSize: 13, marginTop: 8 }}>{error}</p>}
        <button type="submit" disabled={loading} style={buttonStyle}>
          {loading ? '...' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button
        onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        style={{ background: 'none', border: 'none', color: '#E8A33D', marginTop: 16, cursor: 'pointer', fontSize: 13 }}
      >
        {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
      </button>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid rgba(237,230,214,0.15)',
  background: '#2B2523',
  color: '#EDE6D6',
  fontSize: 14,
}

const buttonStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 20,
  padding: '11px 18px',
  borderRadius: 10,
  border: 'none',
  background: '#8C3B2E',
  color: '#EDE6D6',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
}
