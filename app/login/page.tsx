'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabaseClient'
import { forgetSeen } from '@/lib/lastSeen'
import { Banner, Btn, Card, Page } from '@/components/ui'
import { useT } from '@/lib/i18n/react'

export default function LoginPage() {
  const router = useRouter()
  const { t } = useT()
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
    const { error } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

    setLoading(false)
    if (error) {
      // Supabase's own wording; the one everybody hits gets translated, the
      // rest pass through as sent.
      setError(
        error.message === 'Invalid login credentials'
          ? t('login.invalidCredentials')
          : error.message,
      )
      return
    }
    // A new session starts clean: nothing another account left saved for
    // offline on this device (lib/lastSeen.ts).
    forgetSeen()
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
                <label className="label" htmlFor="email">
                  {t('login.email')}
                </label>
                <input
                  id="email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
              <div>
                <label className="label" htmlFor="password">
                  {t('login.password')}
                </label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                />
              </div>
            </div>
            <div className="row-tight">
              <Btn type="submit" disabled={loading}>
                {loading
                  ? t('login.signingIn')
                  : mode === 'signin'
                    ? t('login.signIn')
                    : t('login.createAccount')}
              </Btn>
            </div>
          </form>
        </Card>
        <button
          className="linkish"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin' ? t('login.toSignUp') : t('login.toSignIn')}
        </button>
      </div>
    </Page>
  )
}
