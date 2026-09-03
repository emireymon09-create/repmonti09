'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'
import { Banner, Btn, Card, Page } from '@/components/ui'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error } = mode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password })

    setLoading(false)
    if (error) { setError(error.message); return }
    router.push('/dashboard')
  }

  return (
    <Page>
      <div className="auth">
        <h1 className="title">Amelia</h1>
        {error && <Banner kind="error">{error}</Banner>}
        <Card>
          <form onSubmit={handleSubmit}>
            <div className="stack">
              <div>
                <label className="label" htmlFor="email">Email</label>
                <input id="email" className="input" type="email" value={email}
                  onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              </div>
              <div>
                <label className="label" htmlFor="password">Password</label>
                <input id="password" className="input" type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)} required
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
              </div>
            </div>
            <div className="row-tight">
              <Btn type="submit" disabled={loading}>
                {loading ? 'Signing in…' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </Btn>
            </div>
          </form>
        </Card>
        <button className="linkish" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
          {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
        </button>
      </div>
    </Page>
  )
}
