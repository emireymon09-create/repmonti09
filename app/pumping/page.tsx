'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { logPumping, recentPumping, totalPumped, updatePumping, voidPumping } from '@/lib/db'
import { useT } from '@/lib/i18n/react'
import { useReturnFocus } from '@/lib/useReturnFocus'
import type { MessageKey } from '@/lib/i18n'
import type { PumpingSession, PumpSide } from '@/lib/types'
import {
  clockTime,
  DISPLAY_UNIT,
  formatVolume,
  fromHouseholdInputValue,
  longDate,
  mlToUnit,
  toHouseholdInputValue,
  unitToMl,
} from '@/lib/format'

const SIDES: { value: PumpSide; label: MessageKey }[] = [
  { value: 'left', label: 'sideButton.left' },
  { value: 'right', label: 'sideButton.right' },
  { value: 'both', label: 'sideButton.both' },
]

export default function PumpingPage() {
  const { baby, userId, loading, unreachable } = useBaby()
  const { t, lang } = useT()

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
  useReturnFocus(editingId, !busy)

  const refresh = useCallback(
    async (babyId: string) => {
      const { data, error } = await recentPumping(babyId, 100)
      if (error) setErr(t('milk.couldNotLoad', { error }))
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

    const trimmed = amount.trim()
    let amountMl: number | null = null
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) {
        setErr(t('milk.amountNotNumber'))
        return
      }
      amountMl = Number(unitToMl(parsed, DISPLAY_UNIT).toFixed(1))
    }

    const atIso = fromHouseholdInputValue(at)

    setBusy(true)
    const { error, queued } = await logPumping(
      baby.id,
      userId,
      side,
      amountMl,
      notes.trim() || null,
      atIso,
    )
    setBusy(false)

    if (error) {
      setErr(t('common.couldNotSave', { error }))
      return
    }
    setSaved(queued ? t('common.queued') : t('milk.logged'))
    setAmount('')
    setNotes('')
    setAt(toHouseholdInputValue(new Date()))
    refresh(baby.id)
  }

  function startEdit(row: PumpingSession) {
    setErr(null)
    setESide(row.side)
    setEAmount(row.amount_ml != null ? String(mlToUnit(row.amount_ml, DISPLAY_UNIT)) : '')
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
      if (!Number.isFinite(parsed)) {
        setErr(t('milk.amountNotNumber'))
        return
      }
      amountMl = Number(unitToMl(parsed, DISPLAY_UNIT).toFixed(1))
    }

    setBusy(true)
    const { error } = await updatePumping(editingId, {
      side: eSide,
      amount_ml: amountMl,
      notes: eNotes.trim() || null,
      pumped_at: fromHouseholdInputValue(eAt),
    })
    setBusy(false)

    if (error) {
      setErr(t('common.couldNotSave', { error }))
      return
    }
    setSaved(t('common.saved'))
    setEditingId(null)
    if (baby) refresh(baby.id)
  }

  async function deleteRow(id: string) {
    if (busy) return
    if (!window.confirm(t('milk.removeConfirm'))) return

    setBusy(true)
    setErr(null)
    const { error } = await voidPumping(id)
    setBusy(false)

    if (error) {
      setErr(t('common.couldNotDelete', { error }))
      return
    }
    if (editingId === id) setEditingId(null)
    setSaved(t('common.deleted'))
    if (baby) refresh(baby.id)
  }

  if (loading)
    return (
      <Page>
        {/* El nav va también mientras carga. Sin él, cada navegación entre
            pantallas dejaba la ventana ENTERA vacía —barra de abajo
            incluida— hasta que useBaby() resolvía: eso era el "pantallazo"
            entre pantallas. Medido con CDP: existía una ventana sin nav y
            sin contenido, de 34 ms en este servidor y tanto más cuanto peor
            esté la conexión. */}
        <Nav />
        <p className="empty loading-note">{t('common.loading')}</p>
      </Page>
    )
  if (!baby)
    return (
      <Page>
        <Nav />
        <NoBaby offline={unreachable} />
      </Page>
    )

  // Building the stash starts weeks before the due date, so this page
  // works even on the "Expecting" screen — it never checks birth_date.
  // A reset only changes what counts toward the total, never History.
  const resetAt = baby.pumping_reset_at
  const counted = resetAt ? rows.filter((r) => r.pumped_at > resetAt) : rows
  const total = totalPumped(counted)

  return (
    <Page>
      <Nav />
      <h1 className="title">{t('milk.title')}</h1>
      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      <Grid>
        <Card>
          <form onSubmit={save}>
            <Label>{t('milk.logTitle')}</Label>
            <div className="stack">
              {/* `row-wrap`: en español los tres lados son "Izquierdo /
                  Derecho / Ambos", y en la pared, con el tipo grande, no
                  entran en la columna — medido el 25 sep 2026, la fila se
                  salía 24 px de su caja a 1440px (no daba scroll horizontal
                  de página, por eso un chequeo a nivel página no lo veía).
                  Envuelve, no desborda; es el mismo recurso que ya usa la
                  fila del biberón en /dashboard. */}
              <div className="row row-wrap">
                {SIDES.map((s) => (
                  <Btn
                    key={s.value}
                    variant={side === s.value ? 'action' : 'quiet'}
                    onClick={() => setSide(s.value)}
                  >
                    {t(s.label)}
                  </Btn>
                ))}
              </div>
              <input
                className="input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder={t('common.unitOptional', { unit: t(`unit.${DISPLAY_UNIT}`) })}
                aria-label={t('milk.amount', { unit: t(`unit.${DISPLAY_UNIT}`) })}
              />
              <input
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('common.notesOptional')}
                aria-label={t('common.notes')}
              />
              <div>
                <label className="label" htmlFor="pump-at">
                  {t('milk.when')}
                </label>
                <input
                  id="pump-at"
                  type="datetime-local"
                  className="input"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  max={toHouseholdInputValue(new Date())}
                />
              </div>
            </div>
            <div className="row-tight">
              <Btn type="submit" disabled={busy}>
                {busy ? t('common.saving') : t('milk.logSession')}
              </Btn>
            </div>
          </form>
        </Card>

        <Card>
          <Label>{t('milk.inStash')}</Label>
          <div className="value">{formatVolume(total, DISPLAY_UNIT)}</div>
          <div className="meta">
            {t('milk.counted', { count: counted.length })}
            {resetAt && t('milk.since', { date: longDate(resetAt, lang) })}
          </div>
        </Card>

        {rows.length === 0 ? (
          <Card>
            <div className="empty">{t('milk.empty')}</div>
          </Card>
        ) : (
          rows.map((row) => (
            <Card key={row.id}>
              {editingId === row.id ? (
                <div className="stack">
                  <Label>{t('milk.editSession')}</Label>
                  {/* Misma fila, mismo motivo que arriba. */}
                  <div className="row row-wrap">
                    {SIDES.map((s) => (
                      <Btn
                        key={s.value}
                        variant={eSide === s.value ? 'action' : 'quiet'}
                        onClick={() => setESide(s.value)}
                      >
                        {t(s.label)}
                      </Btn>
                    ))}
                  </div>
                  <input
                    className="input"
                    value={eAmount}
                    onChange={(e) => setEAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder={t('common.unitOptional', { unit: t(`unit.${DISPLAY_UNIT}`) })}
                    aria-label={t('milk.amount', { unit: t(`unit.${DISPLAY_UNIT}`) })}
                  />
                  <input
                    className="input"
                    value={eNotes}
                    onChange={(e) => setENotes(e.target.value)}
                    placeholder={t('common.notesOptional')}
                    aria-label={t('common.notes')}
                  />
                  <input
                    type="datetime-local"
                    className="input"
                    value={eAt}
                    onChange={(e) => setEAt(e.target.value)}
                    max={toHouseholdInputValue(new Date())}
                    aria-label={t('common.timeItHappened')}
                  />
                  <div className="row">
                    <Btn disabled={busy} onClick={saveEdit}>
                      {t('common.save')}
                    </Btn>
                    <Btn variant="quiet" onClick={() => setEditingId(null)}>
                      {t('common.cancel')}
                    </Btn>
                  </div>
                </div>
              ) : (
                <>
                  <div className="between">
                    <Label>
                      {longDate(row.pumped_at, lang)} · {clockTime(row.pumped_at, lang)}
                    </Label>
                    <span className="feed-actions">
                      <button
                        type="button"
                        className="linkish"
                        data-edit-for={row.id}
                        disabled={busy || editingId !== null}
                        onClick={() => startEdit(row)}
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        className="linkish"
                        disabled={busy || editingId !== null}
                        onClick={() => deleteRow(row.id)}
                      >
                        {t('common.delete')}
                      </button>
                    </span>
                  </div>
                  <div className="value">
                    {row.amount_ml != null
                      ? formatVolume(row.amount_ml, DISPLAY_UNIT)
                      : t('milk.noAmount')}
                    {' · '}
                    {t(`sideButton.${row.side}`)}
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
