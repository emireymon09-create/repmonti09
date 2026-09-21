'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { GrowthFields, UnitToggle } from '@/components/GrowthFields'
import { addGrowth, listGrowth, updateGrowth, voidGrowth } from '@/lib/db'
import type { GrowthMeasurement } from '@/lib/types'
import {
  cmToIn,
  emptyGrowthInput,
  growthInputFromMetric,
  growthInputToMetric,
  householdToday,
  kgToLbOz,
  measuredOn,
  resolveGrowthEdit,
  type GrowthInput,
} from '@/lib/format'

const QUEUED = 'Saved on this device — will sync when you’re back online'

export default function GrowthPage() {
  const { baby, userId, loading } = useBaby()

  const [rows, setRows] = useState<GrowthMeasurement[]>([])
  // The pediatrician's office says lb/oz and inches out loud; the
  // database stores metric. Default to what gets spoken.
  const [input, setInput] = useState<GrowthInput>(() => emptyGrowthInput(true))
  const [date, setDate] = useState(() => householdToday())
  const [notes, setNotes] = useState('')

  // Editing one row at a time. `editBase` is the form as it was prefilled, so
  // an untouched weight or height keeps its exact stored value.
  const [editing, setEditing] = useState<GrowthMeasurement | null>(null)
  const [editBase, setEditBase] = useState<GrowthInput>(() => emptyGrowthInput(true))
  const [editInput, setEditInput] = useState<GrowthInput>(() => emptyGrowthInput(true))
  const [editDate, setEditDate] = useState('')
  const [editNotes, setEditNotes] = useState('')

  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (babyId: string) => {
    const { data, error } = await listGrowth(babyId)
    if (error) setErr(`Couldn't load measurements — ${error}`)
    setRows(data)
  }, [])

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)

    const metric = growthInputToMetric(input)
    if ('error' in metric) {
      setErr(metric.error)
      return
    }

    setBusy(true)
    const { error, queued } = await addGrowth(baby.id, userId, {
      measured_at: date,
      weight_kg: metric.weightKg,
      height_cm: metric.heightCm,
      notes: notes.trim() || null,
    })
    setBusy(false)

    if (error) {
      setErr(`Couldn't save — ${error}`)
      return
    }
    setSaved(queued ? QUEUED : 'Measurement saved')
    setInput(emptyGrowthInput(input.imperial))
    setNotes('')
    refresh(baby.id)
  }

  function startEdit(row: GrowthMeasurement) {
    setErr(null)
    setSaved(null)
    const base = growthInputFromMetric(row.weight_kg, row.height_cm, input.imperial)
    setEditing(row)
    setEditBase(base)
    setEditInput(base)
    setEditDate(row.measured_at)
    setEditNotes(row.notes ?? '')
  }

  async function saveEdit() {
    if (!baby || !editing || busy) return
    setErr(null)

    const metric = resolveGrowthEdit(editBase, editInput, {
      weightKg: editing.weight_kg,
      heightCm: editing.height_cm,
    })
    if ('error' in metric) {
      setErr(metric.error)
      return
    }

    setBusy(true)
    const { error, queued } = await updateGrowth(editing.id, {
      measured_at: editDate,
      weight_kg: metric.weightKg,
      height_cm: metric.heightCm,
      notes: editNotes.trim() || null,
    })
    setBusy(false)

    if (error) {
      setErr(`Couldn't save the change — ${error}`)
      return
    }
    setSaved(queued ? QUEUED : 'Measurement updated')
    setEditing(null)
    refresh(baby.id)
  }

  async function remove(row: GrowthMeasurement) {
    if (!baby || busy) return
    if (
      !window.confirm(
        `Remove the ${measuredOn(row.measured_at)} measurement? It stops counting toward the growth curve.`,
      )
    )
      return

    setBusy(true)
    setErr(null)
    const { error, queued } = await voidGrowth(row.id)
    setBusy(false)

    if (error) {
      setErr(`Couldn't remove — ${error}`)
      return
    }
    setSaved(queued ? QUEUED : 'Measurement removed')
    refresh(baby.id)
  }

  if (loading)
    return (
      <Page>
        <p className="empty">Loading…</p>
      </Page>
    )
  if (!baby)
    return (
      <Page>
        <Nav />
        <NoBaby />
      </Page>
    )

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
              <UnitToggle value={input} onChange={setInput} />
            </div>

            <div className="stack">
              <input
                className="input"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Date measured"
              />
              <GrowthFields value={input} onChange={setInput} />
              <input
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)"
                aria-label="Notes"
              />
            </div>

            <div className="row-tight">
              <Btn type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save measurement'}
              </Btn>
            </div>
          </form>
        </Card>

        {rows.length === 0 ? (
          <Card>
            <div className="empty">No measurements recorded yet.</div>
          </Card>
        ) : (
          rows.map((row, index) => {
            // Newest first, so the next entry is the previous visit.
            const prev = rows[index + 1]
            const gain =
              prev && row.weight_kg != null && prev.weight_kg != null
                ? row.weight_kg - prev.weight_kg
                : null
            const isEditing = editing?.id === row.id
            return (
              <Card key={row.id}>
                <div className="between">
                  <Label>{measuredOn(row.measured_at)}</Label>
                  {!isEditing && (
                    <span className="feed-actions">
                      <button
                        type="button"
                        className="linkish"
                        disabled={busy}
                        onClick={() => startEdit(row)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="linkish"
                        disabled={busy}
                        onClick={() => remove(row)}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </div>

                {isEditing ? (
                  <div className="edit-panel">
                    <div className="between">
                      <Label>Edit measurement</Label>
                      <UnitToggle value={editInput} onChange={setEditInput} />
                    </div>
                    <div className="stack">
                      <input
                        className="input"
                        type="date"
                        value={editDate}
                        onChange={(e) => setEditDate(e.target.value)}
                        aria-label="Date measured"
                      />
                      <GrowthFields value={editInput} onChange={setEditInput} />
                      <input
                        className="input"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Notes (optional)"
                        aria-label="Notes"
                      />
                    </div>
                    <div className="row-tight">
                      <Btn disabled={busy} onClick={saveEdit}>
                        {busy ? 'Saving…' : 'Save changes'}
                      </Btn>
                      <Btn variant="quiet" onClick={() => setEditing(null)}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="value">
                      {row.weight_kg != null &&
                        `${kgToLbOz(row.weight_kg)} (${row.weight_kg.toFixed(2)} kg)`}
                      {row.weight_kg != null && row.height_cm != null && ' · '}
                      {row.height_cm != null &&
                        `${cmToIn(row.height_cm)} (${row.height_cm.toFixed(1)} cm)`}
                    </div>
                    {gain !== null && (
                      <div className={gain >= 0 ? 'gain-up' : 'gain-down'}>
                        {gain >= 0 ? '+' : '−'}
                        {kgToLbOz(Math.abs(gain))} since last visit
                      </div>
                    )}
                    {row.notes && <div className="meta">{row.notes}</div>}
                  </>
                )}
              </Card>
            )
          })
        )}
      </Grid>
    </Page>
  )
}
