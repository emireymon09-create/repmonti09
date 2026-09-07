'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { logPumping, recentPumping, totalPumped } from '@/lib/db'
import type { PumpingSession, PumpSide } from '@/lib/types'
import { clockTime, flOzToMl, longDate, mlToFlOz } from '@/lib/format'

const SIDES: { value: PumpSide; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'both', label: 'Both' },
]

export default function PumpingPage() {
  const { baby, userId, loading } = useBaby()

  const [rows, setRows] = useState<PumpingSession[]>([])
  const [side, setSide] = useState<PumpSide>('both')
  const [oz, setOz] = useState('')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (babyId: string) => {
    const { data, error } = await recentPumping(babyId, 100)
    if (error) setErr(`Couldn't load sessions — ${error}`)
    setRows(data)
  }, [])

  useEffect(() => { if (baby) refresh(baby.id) }, [baby, refresh])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)

    const trimmed = oz.trim()
    let amountMl: number | null = null
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) { setErr('Amount has to be a number.'); return }
      amountMl = Number(flOzToMl(parsed).toFixed(1))
    }

    setBusy(true)
    const { error, queued } = await logPumping(baby.id, userId, side, amountMl, notes.trim() || null)
    setBusy(false)

    if (error) { setErr(`Couldn't save — ${error}`); return }
    setSaved(queued ? 'Saved on this device — will sync when you’re back online' : 'Session logged')
    setOz(''); setNotes('')
    refresh(baby.id)
  }

  if (loading) return <Page><p className="empty">Loading…</p></Page>
  if (!baby) return <Page><Nav /><NoBaby /></Page>

  // Building the stash starts weeks before the due date, so this page
  // works even on the "Expecting" screen — it never checks birth_date.
  // A reset only changes what counts toward the total, never History.
  const resetAt = baby.pumping_reset_at
  const counted = resetAt ? rows.filter((r) => r.pumped_at > resetAt) : rows
  const total = totalPumped(counted)

  return (
    <Page>
      <Nav babyId={baby.id} />
      <h1 className="title">Milk</h1>
      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      <Grid>
        <Card>
          <form onSubmit={save}>
            <Label>Log a pumping session</Label>
            <div className="stack">
              <div className="row">
                {SIDES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={side === s.value ? 'btn' : 'btn quiet'}
                    onClick={() => setSide(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <input className="input" value={oz} onChange={(e) => setOz(e.target.value)}
                inputMode="decimal" placeholder="oz (optional)" aria-label="Amount, ounces" />
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)" aria-label="Notes" />
            </div>
            <div className="row-tight">
              <Btn type="submit" disabled={busy}>{busy ? 'Saving…' : 'Log session'}</Btn>
            </div>
          </form>
        </Card>

        <Card>
          <Label>In the stash</Label>
          <div className="value">{mlToFlOz(total)}</div>
          <div className="meta">
            {counted.length} session{counted.length === 1 ? '' : 's'} counted
            {resetAt && ` since ${longDate(resetAt)}`}
          </div>
        </Card>

        {rows.length === 0 ? (
          <Card><div className="empty">No sessions logged yet.</div></Card>
        ) : (
          rows.map((row) => (
            <Card key={row.id}>
              <Label>{longDate(row.pumped_at)} · {clockTime(row.pumped_at)}</Label>
              <div className="value">
                {row.amount_ml != null ? mlToFlOz(row.amount_ml) : 'No amount'}
                {' · '}{SIDES.find((s) => s.value === row.side)?.label ?? row.side}
              </div>
              {row.notes && <div className="meta">{row.notes}</div>}
            </Card>
          ))
        )}
      </Grid>
    </Page>
  )
}
