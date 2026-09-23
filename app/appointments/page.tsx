'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, EmptyState, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { addAppointment, listAppointments, setAppointmentCompleted } from '@/lib/db'
import type { AppointmentType, DoctorAppointment } from '@/lib/types'
import { apptWhen, fromHouseholdInputValue, toHouseholdInputValue } from '@/lib/format'
import { useT } from '@/lib/i18n/react'

const APPOINTMENT_TYPES: AppointmentType[] = ['checkup', 'vaccine', 'sick_visit', 'other']

export default function AppointmentsPage() {
  const { baby, userId, loading, unreachable } = useBaby()
  const { t } = useT()

  const [rows, setRows] = useState<DoctorAppointment[]>([])
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<AppointmentType>('checkup')
  const [when, setWhen] = useState(() => toHouseholdInputValue())
  const [doctor, setDoctor] = useState('')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(
    async (babyId: string) => {
      const { data, error } = await listAppointments(babyId)
      if (error) setErr(t('doctor.couldNotLoad', { error }))
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
    if (!title.trim()) {
      setErr(t('doctor.needTitle'))
      return
    }
    if (!when) {
      setErr(t('doctor.needWhen'))
      return
    }

    setErr(null)
    setBusy(true)
    const { error, queued } = await addAppointment(baby.id, userId, {
      title: title.trim(),
      appointment_type: type,
      // The input shows household wall-clock time; store the UTC instant.
      scheduled_at: fromHouseholdInputValue(when),
      doctor_name: doctor.trim() || null,
      notes: notes.trim() || null,
    })
    setBusy(false)

    if (error) {
      setErr(t('common.couldNotSave', { error }))
      return
    }
    setSaved(queued ? t('common.queued') : t('doctor.saved'))
    setTitle('')
    setDoctor('')
    setNotes('')
    setType('checkup')
    setWhen(toHouseholdInputValue())
    setShowForm(false)
    refresh(baby.id)
  }

  async function toggleCompleted(appt: DoctorAppointment) {
    if (!baby || busy) return
    setBusy(true)
    const { error } = await setAppointmentCompleted(appt.id, !appt.completed)
    setBusy(false)
    if (error) {
      setErr(t('doctor.couldNotUpdate', { error }))
      return
    }
    refresh(baby.id)
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

  const now = Date.now()
  const upcoming = rows.filter((r) => !r.completed && new Date(r.scheduled_at).getTime() >= now)
  const past = rows.filter((r) => r.completed || new Date(r.scheduled_at).getTime() < now).reverse()
  const noAppointments = upcoming.length === 0 && past.length === 0

  return (
    <Page>
      <Nav />
      <div className="between page-head">
        <h1 className="title">{t('doctor.title')}</h1>
        <button
          className="pill"
          onClick={() => {
            setShowForm((v) => !v)
            setErr(null)
          }}
        >
          {showForm ? t('common.cancel') : t('doctor.add')}
        </button>
      </div>

      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      {showForm && (
        <Card>
          <form onSubmit={save}>
            <Label>{t('doctor.new')}</Label>
            <div className="stack">
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('doctor.titlePlaceholder')}
                aria-label={t('doctor.titleLabel')}
              />
              <select
                className="input"
                value={type}
                aria-label={t('doctor.type')}
                onChange={(e) => setType(e.target.value as AppointmentType)}
              >
                {APPOINTMENT_TYPES.map((key) => (
                  <option key={key} value={key}>
                    {t(`apptType.${key}`)}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                aria-label={t('doctor.dateTime')}
              />
              <input
                className="input"
                value={doctor}
                onChange={(e) => setDoctor(e.target.value)}
                placeholder={t('doctor.doctorOptional')}
                aria-label={t('doctor.doctor')}
              />
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
                {busy ? t('common.saving') : t('doctor.saveAppointment')}
              </Btn>
            </div>
            <p className="note">{t('doctor.storedHere')}</p>
          </form>
        </Card>
      )}

      {/* Nada agendado Y nada pasado: la página terminaba en el encabezado y
          una tarjeta de una línea, y de ahí hasta la barra de abajo quedaba
          todo en blanco. Con algo abajo (turnos pasados) el hueco no existe,
          así que ahí se conserva la tarjeta corta de siempre. */}
      {noAppointments ? (
        <div className="empty-fill">
          <EmptyState icon="doctor" title={t('doctor.empty')} hint={t('doctor.emptyHint')} />
        </div>
      ) : (
        <>
          <h2 className="label section-label">{t('doctor.upcoming')}</h2>
          <Grid>
            {upcoming.length === 0 ? (
              <Card>
                <div className="empty">{t('doctor.nothingScheduled')}</div>
              </Card>
            ) : (
              upcoming.map((appt) => (
                <ApptCard key={appt.id} appt={appt} onToggle={toggleCompleted} busy={busy} />
              ))
            )}
          </Grid>

          {past.length > 0 && (
            <>
              <h2 className="label section-label">{t('doctor.past')}</h2>
              <Grid>
                {past.map((appt) => (
                  <ApptCard key={appt.id} appt={appt} onToggle={toggleCompleted} busy={busy} past />
                ))}
              </Grid>
            </>
          )}
        </>
      )}
    </Page>
  )
}

function ApptCard({
  appt,
  onToggle,
  busy,
  past,
}: {
  appt: DoctorAppointment
  onToggle: (appt: DoctorAppointment) => void
  busy: boolean
  past?: boolean
}) {
  const { t, lang } = useT()
  return (
    <Card past={past}>
      <div className="spread">
        <div className="grow">
          <div className={appt.completed ? 'value strike' : 'value'}>{appt.title}</div>
          <div className="meta">
            {apptWhen(appt.scheduled_at, lang)}
            {appt.appointment_type ? ` · ${t(`apptType.${appt.appointment_type}`)}` : ''}
            {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
          </div>
          {appt.notes && <div className="meta">{appt.notes}</div>}
        </div>
        <button
          className={appt.completed ? 'check is-done' : 'check'}
          onClick={() => onToggle(appt)}
          disabled={busy}
          aria-label={appt.completed ? t('doctor.markNotDone') : t('doctor.markDone')}
        >
          ✓
        </button>
      </div>
    </Card>
  )
}
