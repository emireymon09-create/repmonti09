'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { GrowthFields, UnitToggle } from '@/components/GrowthFields'
import { addGrowth, listGrowth, updateGrowth, voidGrowth } from '@/lib/db'
import type { GrowthMeasurement } from '@/lib/types'
import { useT } from '@/lib/i18n/react'
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

export default function GrowthPage() {
  const { baby, userId, loading } = useBaby()
  const { t, lang } = useT()

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

  const refresh = useCallback(
    async (babyId: string) => {
      const { data, error } = await listGrowth(babyId)
      if (error) setErr(t('growth.couldNotLoad', { error }))
      setRows(data)
    },
    [t],
  )

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    setErr(null)

    const metric = growthInputToMetric(input, lang)
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
      setErr(t('common.couldNotSave', { error }))
      return
    }
    setSaved(queued ? t('common.queued') : t('growth.saved'))
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

    const metric = resolveGrowthEdit(
      editBase,
      editInput,
      { weightKg: editing.weight_kg, heightCm: editing.height_cm },
      lang,
    )
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
      setErr(t('growth.couldNotSaveChange', { error }))
      return
    }
    setSaved(queued ? t('common.queued') : t('growth.updated'))
    setEditing(null)
    refresh(baby.id)
  }

  async function remove(row: GrowthMeasurement) {
    if (!baby || busy) return
    if (!window.confirm(t('growth.removeConfirm', { date: measuredOn(row.measured_at, lang) })))
      return

    setBusy(true)
    setErr(null)
    const { error, queued } = await voidGrowth(row.id)
    setBusy(false)

    if (error) {
      setErr(t('growth.couldNotRemove', { error }))
      return
    }
    setSaved(queued ? t('common.queued') : t('growth.removed'))
    refresh(baby.id)
  }

  if (loading)
    return (
      <Page>
        <p className="empty">{t('common.loading')}</p>
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
      <h1 className="title">{t('growth.title')}</h1>
      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      <Grid>
        <Card>
          <form onSubmit={save}>
            <div className="between">
              <Label>{t('growth.new')}</Label>
              <UnitToggle value={input} onChange={setInput} />
            </div>

            <div className="stack">
              <input
                className="input"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label={t('growth.dateMeasured')}
              />
              <GrowthFields value={input} onChange={setInput} />
              <input
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('common.notesOptional')}
                aria-label={t('common.notes')}
              />
            </div>

            <div className="row-tight">
              <Btn type="submit" disabled={busy}>
                {busy ? t('common.saving') : t('growth.saveMeasurement')}
              </Btn>
            </div>
          </form>
        </Card>

        {rows.length === 0 ? (
          <Card>
            <div className="empty">{t('growth.empty')}</div>
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
                {isEditing ? (
                  <div className="stack">
                    <div className="between">
                      <Label>
                        {t('growth.editing', { date: measuredOn(row.measured_at, lang) })}
                      </Label>
                      <UnitToggle value={editInput} onChange={setEditInput} />
                    </div>
                    <div className="stack">
                      <input
                        className="input"
                        type="date"
                        value={editDate}
                        onChange={(e) => setEditDate(e.target.value)}
                        aria-label={t('growth.dateMeasured')}
                      />
                      <GrowthFields value={editInput} onChange={setEditInput} />
                      <input
                        className="input"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder={t('common.notesOptional')}
                        aria-label={t('common.notes')}
                      />
                    </div>
                    <div className="row">
                      <Btn disabled={busy} onClick={saveEdit}>
                        {busy ? t('common.saving') : t('growth.saveChanges')}
                      </Btn>
                      <Btn variant="quiet" onClick={() => setEditing(null)}>
                        {t('common.cancel')}
                      </Btn>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="between">
                      <Label>{measuredOn(row.measured_at, lang)}</Label>
                      {/* One entry open at a time: while another is being
                          edited, these wait, so no second form or confirm
                          can open on top of unsaved changes. */}
                      <span className="feed-actions">
                        <button
                          type="button"
                          className="linkish"
                          disabled={busy || editing !== null}
                          onClick={() => startEdit(row)}
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          className="linkish"
                          disabled={busy || editing !== null}
                          onClick={() => remove(row)}
                        >
                          {t('common.delete')}
                        </button>
                      </span>
                    </div>
                    <div className="value">
                      {row.weight_kg != null &&
                        `${kgToLbOz(row.weight_kg)} (${row.weight_kg.toFixed(2)} kg)`}
                      {row.weight_kg != null && row.height_cm != null && ' · '}
                      {row.height_cm != null &&
                        `${cmToIn(row.height_cm)} (${row.height_cm.toFixed(1)} cm)`}
                    </div>
                    {gain !== null && (
                      <div className={gain >= 0 ? 'gain-up' : 'gain-down'}>
                        {t('growth.sinceLast', {
                          change: `${gain >= 0 ? '+' : '−'}${kgToLbOz(Math.abs(gain))}`,
                        })}
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
