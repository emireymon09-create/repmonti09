'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { addGrowth, listGrowth } from '@/lib/db'
import type { GrowthMeasurement } from '@/lib/types'
import { cmToIn, householdToday, kgToLbOz, lbOzToKg, measuredOn } from '@/lib/format'

export default function GrowthPage() {
  const { baby, userId, loading } = useBaby()

  const [rows, setRows] = useState<GrowthMeasurement[]>([])
  // The pediatrician's office says lb/oz and inches out loud; the
  // database stores metric. Default to what gets spoken.
  const [imperial, setImperial] = useState(true)
  const [date, setDate] = useState(() => householdToday())
  const [lb, setLb] = useState('')
  const [oz, setOz] = useState('')
  const [kg, setKg] = useState('')
  const [inches, setInches] = useState('')
  const [cm, setCm] = useState('')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (babyId: string) => {
    const { data, error } = await listGrowth(babyId)
    if (error) setErr(`Couldn't load measurements — ${error}`)
    setRows(data)
  }, [])

  useEffect(() => { if (baby) refresh(baby.id) }, [baby, refresh])

  function num(value: string): number | null {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : NaN
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)

    let weightKg: number | null = null
    let heightCm: number | null = null

    if (imperial) {
      const l = num(lb), o = num(oz), i = num(inches)
      if ([l, o, i].some((v) => v !== null && Number.isNaN(v))) {
        setErr('Weight and height have to be numbers.'); return
      }
      if (l !== null || o !== null) weightKg = lbOzToKg(l ?? 0, o ?? 0)
      if (i !== null) heightCm = i * 2.54
    } else {
      const k = num(kg), c = num(cm)
      if ([k, c].some((v) => v !== null && Number.isNaN(v))) {
        setErr('Weight and height have to be numbers.'); return
      }
      weightKg = k
      heightCm = c
    }

    if (weightKg === null && heightCm === null) {
      setErr('Enter a weight, a height, or both.'); return
    }

    setBusy(true)
    const { error, queued } = await addGrowth(baby.id, userId, {
      measured_at: date,
      weight_kg: weightKg === null ? null : Number(weightKg.toFixed(3)),
      height_cm: heightCm === null ? null : Number(heightCm.toFixed(1)),
      notes: notes.trim() || null,
    })
    setBusy(false)

    if (error) { setErr(`Couldn't save — ${error}`); return }
    setSaved(queued ? 'Saved on this device — will sync when you\u2019re back online' : 'Measurement saved')
    setLb(''); setOz(''); setKg(''); setInches(''); setCm(''); setNotes('')
    refresh(baby.id)
  }

  if (loading) return <Page><p className="empty">Loading…</p></Page>
  if (!baby) return <Page><Nav /><NoBaby /></Page>

  return (
    <Page>
      <Nav babyId={baby.id} />
      <h1 className="title">Growth</h1>
      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      <Grid>
        <Card>
          <form onSubmit={save}>
            <div className="between">
              <Label>New measurement</Label>
              <button type="button" className="linkish" onClick={() => setImperial((v) => !v)}>
                {imperial ? 'lb / in' : 'kg / cm'}
              </button>
            </div>

            <div className="stack">
              <input className="input" type="date" value={date}
                onChange={(e) => setDate(e.target.value)} aria-label="Date measured" />

              {imperial ? (
                <div className="row">
                  <input className="input" value={lb} onChange={(e) => setLb(e.target.value)}
                    inputMode="decimal" placeholder="lb" aria-label="Weight, pounds" />
                  <input className="input" value={oz} onChange={(e) => setOz(e.target.value)}
                    inputMode="decimal" placeholder="oz" aria-label="Weight, ounces" />
                  <input className="input" value={inches} onChange={(e) => setInches(e.target.value)}
                    inputMode="decimal" placeholder="in" aria-label="Height, inches" />
                </div>
              ) : (
                <div className="row">
                  <input className="input" value={kg} onChange={(e) => setKg(e.target.value)}
                    inputMode="decimal" placeholder="kg" aria-label="Weight, kilograms" />
                  <input className="input" value={cm} onChange={(e) => setCm(e.target.value)}
                    inputMode="decimal" placeholder="cm" aria-label="Height, centimetres" />
                </div>
              )}

              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)" aria-label="Notes" />
            </div>

            <div className="row-tight">
              <Btn type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save measurement'}</Btn>
            </div>
          </form>
        </Card>

        {rows.length === 0 ? (
          <Card><div className="empty">No measurements recorded yet.</div></Card>
        ) : (
          rows.map((row, index) => {
            // Newest first, so the next entry is the previous visit.
            const prev = rows[index + 1]
            const gain = prev && row.weight_kg != null && prev.weight_kg != null
              ? row.weight_kg - prev.weight_kg
              : null
            return (
              <Card key={row.id}>
                <Label>{measuredOn(row.measured_at)}</Label>
                <div className="value">
                  {row.weight_kg != null && `${kgToLbOz(row.weight_kg)} (${row.weight_kg.toFixed(2)} kg)`}
                  {row.weight_kg != null && row.height_cm != null && ' · '}
                  {row.height_cm != null && `${cmToIn(row.height_cm)} (${row.height_cm.toFixed(1)} cm)`}
                </div>
                {gain !== null && (
                  <div className={gain >= 0 ? 'gain-up' : 'gain-down'}>
                    {gain >= 0 ? '+' : '−'}{kgToLbOz(Math.abs(gain))} since last visit
                  </div>
                )}
                {row.notes && <div className="meta">{row.notes}</div>}
              </Card>
            )
          })
        )}
      </Grid>
    </Page>
  )
}
