'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { logPumping, recentPumping, totalPumped, updatePumping, voidPumping } from '@/lib/db'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
import type { PumpingSession, PumpSide } from '@/lib/types'
import {
  clockTime, formatVolume, fromHouseholdInputValue, longDate, mlToUnit, toHouseholdInputValue,
  unitToMl,
} from '@/lib/format'

const SIDES: { value: PumpSide; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'both', label: 'Both' },
]

export default function PumpingPage() {
  const { baby, userId, loading } = useBaby()
  const [unit] = useVolumeUnit()

  const [rows, setRows] = useState<PumpingSession[]>([])
  const [side, setSide] = useState<PumpSide>('both')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  // Defaults to right now; only touch it to log a session you missed
  // in the moment, e.g. catching up after the app was down.
  const [at, setAt] = useState(() => toHouseholdInputValue(new Date()))
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Editing an already-logged session — separate from the log form above.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [eSide, setESide] = useState<PumpSide>('both')
  const [eAmount, setEAmount] = useState('')
  const [eNotes, setENotes] = useState('')
  const [eAt, setEAt] = useState('')

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

    const trimmed = amount.trim()
    let amountMl: number | null = null
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) { setErr('Amount has to be a number.'); return }
      amountMl = Number(unitToMl(parsed, unit).toFixed(1))
    }

    const atIso = fromHouseholdInputValue(at)

    setBusy(true)
    const { error, queued } = await logPumping(
      baby.id, userId, side, amountMl, notes.trim() || null, atIso,
    )
    setBusy(false)

    if (error) { setErr(`Couldn't save — ${error}`); return }
    setSaved(queued ? 'Saved on this device — will sync when you’re back online' : 'Session logged')
    setAmount(''); setNotes(''); setAt(toHouseholdInputValue(new Date()))
    refresh(baby.id)
  }

  function startEdit(row: PumpingSession) {
    setErr(null)
    setESide(row.side)
    setEAmount(row.amount_ml != null ? String(mlToUnit(row.amount_ml, unit)) : '')
    setENotes(row.notes ?? '')
    setEAt(toHouseholdInputValue(new Date(row.pumped_at)))
    setEditingId(row.id)
  }

  async function saveEdit() {
    if (!editingId || busy) return
    setErr(null)

    const trimmed = eAmount.trim()
    let amountMl: number | null = null
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) { setErr('Amount has to be a number.'); return }
      amountMl = Number(unitToMl(parsed, unit).toFixed(1))
    }

    setBusy(true)
    const { error } = await updatePumping(editingId, {
      side: eSide, amount_ml: amountMl, notes: eNotes.trim() || null,
      pumped_at: fromHouseholdInputValue(eAt),
    })
    setBusy(false)

    if (error) { setErr(`Couldn't save — ${error}`); return }
    setSaved('Saved')
    setEditingId(null)
    if (baby) refresh(baby.id)
  }

  async function deleteRow(id: string) {
    if (busy) return
    if (!window.confirm('Remove this session? It comes out of the stash total too.')) return

    setBusy(true)
    setErr(null)
    const { error } = await voidPumping(id)
    setBusy(false)

    if (error) { setErr(`Couldn't delete — ${error}`); return }
    if (editingId === id) setEditingId(null)
    setSaved('Deleted')
    if (baby) refresh(baby.id)
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
              <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal" placeholder={`${unit} (optional)`} aria-label={`Amount, ${unit}`} />
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)" aria-label="Notes" />
              <div>
                <label className="label" htmlFor="pump-at">When (defaults to now)</label>
                <input id="pump-at" type="datetime-local" className="input" value={at}
                  onChange={(e) => setAt(e.target.value)}
                  max={toHouseholdInputValue(new Date())} />
              </div>
            </div>
            <div className="row-tight">
              <Btn type="submit" disabled={busy}>{busy ? 'Saving…' : 'Log session'}</Btn>
            </div>
          </form>
        </Card>

        <Card>
          <Label>In the stash</Label>
          <div className="value">{formatVolume(total, unit)}</div>
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
              {editingId === row.id ? (
                <div className="stack">
                  <Label>Edit session</Label>
                  <div className="row">
                    {SIDES.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className={eSide === s.value ? 'btn' : 'btn quiet'}
                        onClick={() => setESide(s.value)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <input className="input" value={eAmount} onChange={(e) => setEAmount(e.target.value)}
                    inputMode="decimal" placeholder={`${unit} (optional)`} aria-label={`Amount, ${unit}`} />
                  <input className="input" value={eNotes} onChange={(e) => setENotes(e.target.value)}
                    placeholder="Notes (optional)" aria-label="Notes" />
                  <input type="datetime-local" className="input" value={eAt}
                    onChange={(e) => setEAt(e.target.value)}
                    max={toHouseholdInputValue(new Date())} aria-label="Time it happened" />
                  <div className="row-tight">
                    <Btn disabled={busy} onClick={saveEdit}>Save</Btn>
                    <Btn variant="quiet" onClick={() => setEditingId(null)}>Cancel</Btn>
                  </div>
                </div>
              ) : (
                <>
                  <div className="between">
                    <Label>{longDate(row.pumped_at)} · {clockTime(row.pumped_at)}</Label>
                    <span className="feed-actions">
                      <button type="button" className="linkish" disabled={busy} onClick={() => startEdit(row)}>
                        Edit
                      </button>
                      <button type="button" className="linkish" disabled={busy} onClick={() => deleteRow(row.id)}>
                        Delete
                      </button>
                    </span>
                  </div>
                  <div className="value">
                    {row.amount_ml != null ? formatVolume(row.amount_ml, unit) : 'No amount'}
                    {' · '}{SIDES.find((s) => s.value === row.side)?.label ?? row.side}
                  </div>
                  {row.notes && <div className="meta">{row.notes}</div>}
                </>
              )}
            </Card>
          ))
        )}
      </Grid>
    </Page>
  )
}
