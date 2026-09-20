'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import { addAppointment, listAppointments, setAppointmentCompleted } from '@/lib/db'
import { APPOINTMENT_TYPE_LABELS } from '@/lib/types'
import type { AppointmentType, DoctorAppointment } from '@/lib/types'
import { apptWhen, fromHouseholdInputValue, toHouseholdInputValue } from '@/lib/format'

export default function AppointmentsPage() {
  const { baby, userId, loading } = useBaby()

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

  const refresh = useCallback(async (babyId: string) => {
    const { data, error } = await listAppointments(babyId)
    if (error) setErr(`Couldn't load appointments — ${error}`)
    setRows(data)
  }, [])

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    if (!title.trim()) {
      setErr('Give the appointment a title.')
      return
    }
    if (!when) {
      setErr('Pick a date and time.')
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
      setErr(`Couldn't save — ${error}`)
      return
    }
    setSaved(
      queued
        ? 'Saved on this device — will sync when you\u2019re back online'
        : 'Appointment saved',
    )
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
      setErr(`Couldn't update — ${error}`)
      return
    }
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

  const now = Date.now()
  const upcoming = rows.filter((r) => !r.completed && new Date(r.scheduled_at).getTime() >= now)
  const past = rows.filter((r) => r.completed || new Date(r.scheduled_at).getTime() < now).reverse()

  return (
    <Page>
      <Nav babyId={baby.id} />
      <div className="between">
        <h1 className="title">Doctor</h1>
        <button
          className="pill"
          onClick={() => {
            setShowForm((v) => !v)
            setErr(null)
          }}
        >
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {saved && !err && <Banner kind="ok">{saved}</Banner>}

      {showForm && (
        <Card>
          <form onSubmit={save}>
            <Label>New appointment</Label>
            <div className="stack">
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. 2-month checkup"
                aria-label="Title"
              />
              <select
                className="input"
                value={type}
                aria-label="Appointment type"
                onChange={(e) => setType(e.target.value as AppointmentType)}
              >
                {(Object.keys(APPOINTMENT_TYPE_LABELS) as AppointmentType[]).map((key) => (
                  <option key={key} value={key}>
                    {APPOINTMENT_TYPE_LABELS[key]}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                aria-label="Date and time"
              />
              <input
                className="input"
                value={doctor}
                onChange={(e) => setDoctor(e.target.value)}
                placeholder="Doctor (optional)"
                aria-label="Doctor"
              />
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
                {busy ? 'Saving…' : 'Save appointment'}
              </Btn>
            </div>
            <p className="note">
              Stored here only. Syncing to the shared calendar is the Hub&rsquo;s job later.
            </p>
          </form>
        </Card>
      )}

      <Label>Upcoming</Label>
      <Grid>
        {upcoming.length === 0 ? (
          <Card>
            <div className="empty">Nothing scheduled.</div>
          </Card>
        ) : (
          upcoming.map((appt) => (
            <ApptCard key={appt.id} appt={appt} onToggle={toggleCompleted} busy={busy} />
          ))
        )}
      </Grid>

      {past.length > 0 && (
        <>
          <Label>Past</Label>
          <Grid>
            {past.map((appt) => (
              <ApptCard key={appt.id} appt={appt} onToggle={toggleCompleted} busy={busy} past />
            ))}
          </Grid>
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
  return (
    <Card past={past}>
      <div className="spread">
        <div className="grow">
          <div className={appt.completed ? 'value strike' : 'value'}>{appt.title}</div>
          <div className="meta">
            {apptWhen(appt.scheduled_at)}
            {appt.appointment_type ? ` · ${APPOINTMENT_TYPE_LABELS[appt.appointment_type]}` : ''}
            {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
          </div>
          {appt.notes && <div className="meta">{appt.notes}</div>}
        </div>
        <button
          className={appt.completed ? 'check is-done' : 'check'}
          onClick={() => onToggle(appt)}
          disabled={busy}
          aria-label={appt.completed ? 'Mark as not done' : 'Mark as done'}
        >
          ✓
        </button>
      </div>
    </Card>
  )
}
