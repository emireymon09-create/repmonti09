'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabaseClient'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Label, Nav, Page, inputStyle, theme } from '@/components/ui'
import { cmToIn, kgToLbOz } from '@/lib/format'

type Measurement = {
  id: string
  measured_at: string
  weight_kg: number | null
  height_cm: number | null
  notes: string | null
}

const LB_PER_KG = 2.20462

export default function GrowthPage() {
  const supabase = createClient()
  const { baby, userId, loading } = useBaby()

  const [rows, setRows] = useState<Measurement[]>([])
  const [imperial, setImperial] = useState(true) // the pediatrician talks in lb/oz
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [lb, setLb] = useState('')
  const [oz, setOz] = useState('')
  const [kg, setKg] = useState('')
  const [inches, setInches] = useState('')
  const [cm, setCm] = useState('')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (babyId: string) => {
    const { data } = await supabase
      .from('growth_measurements')
      .select('id, measured_at, weight_kg, height_cm, notes')
      .eq('baby_id', babyId)
      .order('measured_at', { ascending: false })
    setRows((data ?? []) as Measurement[])
  }, [supabase])

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
      if (l !== null || o !== null) weightKg = ((l ?? 0) + (o ?? 0) / 16) / LB_PER_KG
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
    const { error } = await supabase.from('growth_measurements').insert({
      baby_id: baby.id,
      measured_at: date,
      weight_kg: weightKg === null ? null : Number(weightKg.toFixed(3)),
      height_cm: heightCm === null ? null : Number(heightCm.toFixed(1)),
      notes: notes.trim() || null,
      logged_by: userId,
    })
    setBusy(false)

    if (error) { setErr(`Couldn't save — ${error.message}`); return }
    setLb(''); setOz(''); setKg(''); setInches(''); setCm(''); setNotes('')
    refresh(baby.id)
  }

  if (loading) return <Page><p style={{ color: theme.muted }}>Loading…</p></Page>
  if (!baby) return <Page><Nav /><NoBaby /></Page>

  return (
    <Page>
      <Nav />
      <h1 style={{ fontSize: 26, margin: '0 0 16px' }}>Growth</h1>

      {err && <Banner kind="error">{err}</Banner>}

      <Card>
        <form onSubmit={save}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Label>New measurement</Label>
            <button
              type="button"
              onClick={() => setImperial((v) => !v)}
              style={{ background: 'none', border: 'none', color: theme.accent, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}
            >
              {imperial ? 'lb / in' : 'kg / cm'}
            </button>
          </div>

          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />

          {imperial ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input value={lb} onChange={(e) => setLb(e.target.value)} inputMode="decimal" placeholder="lb" aria-label="Weight, pounds" style={inputStyle} />
              <input value={oz} onChange={(e) => setOz(e.target.value)} inputMode="decimal" placeholder="oz" aria-label="Weight, ounces" style={inputStyle} />
              <input value={inches} onChange={(e) => setInches(e.target.value)} inputMode="decimal" placeholder="in" aria-label="Height, inches" style={inputStyle} />
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input value={kg} onChange={(e) => setKg(e.target.value)} inputMode="decimal" placeholder="kg" aria-label="Weight, kilograms" style={inputStyle} />
              <input value={cm} onChange={(e) => setCm(e.target.value)} inputMode="decimal" placeholder="cm" aria-label="Height, centimetres" style={inputStyle} />
            </div>
          )}

          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" style={{ ...inputStyle, marginBottom: 10 }} />
          <div style={{ display: 'flex' }}>
            <Btn type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save measurement'}</Btn>
          </div>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card><div style={{ color: theme.muted }}>No measurements recorded yet.</div></Card>
      ) : (
        rows.map((row, index) => {
          // rows are newest-first, so the next one in the array is the previous visit
          const prev = rows[index + 1]
          const gain = prev && row.weight_kg != null && prev.weight_kg != null
            ? row.weight_kg - prev.weight_kg
            : null
          return (
            <Card key={row.id}>
              <Label>{new Date(`${row.measured_at}T00:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</Label>
              <div style={{ fontSize: 17, fontWeight: 600 }}>
                {row.weight_kg != null && <span>{kgToLbOz(row.weight_kg)} ({row.weight_kg.toFixed(2)} kg)</span>}
                {row.weight_kg != null && row.height_cm != null && <span style={{ color: theme.muted }}> · </span>}
                {row.height_cm != null && <span>{cmToIn(row.height_cm)} ({row.height_cm.toFixed(1)} cm)</span>}
              </div>
              {gain !== null && (
                <div style={{ fontSize: 13, color: gain >= 0 ? theme.live : theme.accent, marginTop: 2 }}>
                  {gain >= 0 ? '+' : '−'}{kgToLbOz(Math.abs(gain))} since last visit
                </div>
              )}
              {row.notes && <div style={{ fontSize: 13, color: theme.muted, marginTop: 6 }}>{row.notes}</div>}
            </Card>
          )
        })
      )}
    </Page>
  )
}
