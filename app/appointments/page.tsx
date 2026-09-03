'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabaseClient'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Label, Nav, Page, inputStyle, theme } from '@/components/ui'
import { toLocalInputValue } from '@/lib/format'

type ApptType = 'checkup' | 'vaccine' | 'sick_visit' | 'other'

type Appointment = {
  id: string
  title: string
  appointment_type: ApptType | null
  scheduled_at: string
  doctor_name: string | null
  notes: string | null
  completed: boolean
}

const TYPE_LABELS: Record<ApptType, string> = {
  checkup: 'Checkup',
  vaccine: 'Vaccine',
  sick_visit: 'Sick visit',
  other: 'Other',
}

export default function AppointmentsPage() {
  const supabase = createClient()
  const { baby, userId, loading } = useBaby()

  const [rows, setRows] = useState<Appointment[]>([])
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<ApptType>('checkup')
  const [when, setWhen] = useState(() => toLocalInputValue(new Date()))
  const [doctor, setDoctor] = useState('')
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (babyId: string) => {
    const { data } = await supabase
      .from('doctor_appointments')
      .select('id, title, appointment_type, scheduled_at, doctor_name, notes, completed')
      .eq('baby_id', babyId)
      .order('scheduled_at', { ascending: true })
    setRows((data ?? []) as Appointment[])
  }, [supabase])

  useEffect(() => { if (baby) refresh(baby.id) }, [baby, refresh])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!baby || busy) return
    if (!title.trim()) { setErr('Give the appointment a title.'); return }
    if (!when) { setErr('Pick a date and time.'); return }

    setErr(null)
    setBusy(true)
    // datetime-local has no timezone; new Date() reads it as local time,
    // which is what we want before storing it as UTC.
    const { error } = await supabase.from('doctor_appointments').insert({
      baby_id: baby.id,
      title: title.trim(),
      appointment_type: type,
      scheduled_at: new Date(when).toISOString(),
      doctor_name: doctor.trim() || null,
      notes: notes.trim() || null,
      logged_by: userId,
    })
    setBusy(false)

    if (error) { setErr(`Couldn't save — ${error.message}`); return }
    setTitle(''); setDoctor(''); setNotes(''); setType('checkup')
    setWhen(toLocalInputValue(new Date()))
    setShowForm(false)
    refresh(baby.id)
  }

  async function toggleCompleted(appt: Appointment) {
    if (!baby || busy) return
    setBusy(true)
    const { error } = await supabase
      .from('doctor_appointments')
      .update({ completed: !appt.completed })
      .eq('id', appt.id)
    setBusy(false)
    if (error) { setErr(`Couldn't update — ${error.message}`); return }
    refresh(baby.id)
  }

  if (loading) return <Page><p style={{ color: theme.muted }}>Loading…</p></Page>
  if (!baby) return <Page><Nav /><NoBaby /></Page>

  const now = Date.now()
  const upcoming = rows.filter((r) => !r.completed && new Date(r.scheduled_at).getTime() >= now)
  const past = rows
    .filter((r) => r.completed || new Date(r.scheduled_at).getTime() < now)
    .reverse()

  return (
    <Page>
      <Nav />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 16px' }}>
        <h1 style={{ fontSize: 26, margin: 0 }}>Doctor</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          style={{ background: 'none', border: `1px solid ${theme.line}`, color: theme.accent, borderRadius: 999, padding: '8px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      {showForm && (
        <Card>
          <form onSubmit={save}>
            <Label>New appointment</Label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 2-month checkup"
              style={{ ...inputStyle, margin: '8px 0' }} />
            <select value={type} onChange={(e) => setType(e.target.value as ApptType)} style={{ ...inputStyle, marginBottom: 8 }}>
              {(Object.keys(TYPE_LABELS) as ApptType[]).map((key) => (
                <option key={key} value={key}>{TYPE_LABELS[key]}</option>
              ))}
            </select>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
              style={{ ...inputStyle, marginBottom: 8 }} />
            <input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="Doctor (optional)"
              style={{ ...inputStyle, marginBottom: 8 }} />
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)"
              style={{ ...inputStyle, marginBottom: 10 }} />
            <div style={{ display: 'flex' }}>
              <Btn type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save appointment'}</Btn>
            </div>
            <p style={{ fontSize: 12, color: theme.muted, marginBottom: 0 }}>
              Stored here only. Syncing to the shared calendar is the Hub&rsquo;s job later.
            </p>
          </form>
        </Card>
      )}

      <Label>Upcoming</Label>
      <div style={{ marginTop: 8 }}>
        {upcoming.length === 0 ? (
          <Card><div style={{ color: theme.muted }}>Nothing scheduled.</div></Card>
        ) : (
          upcoming.map((appt) => <ApptCard key={appt.id} appt={appt} onToggle={toggleCompleted} busy={busy} />)
        )}
      </div>

      {past.length > 0 && (
        <>
          <Label>Past</Label>
          <div style={{ marginTop: 8 }}>
            {past.map((appt) => <ApptCard key={appt.id} appt={appt} onToggle={toggleCompleted} busy={busy} past />)}
          </div>
        </>
      )}
    </Page>
  )
}

function ApptCard({ appt, onToggle, busy, past }: {
  appt: Appointment
  onToggle: (appt: Appointment) => void
  busy: boolean
  past?: boolean
}) {
  return (
    <Card style={past ? { opacity: 0.65 } : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, textDecoration: appt.completed ? 'line-through' : 'none' }}>
            {appt.title}
          </div>
          <div style={{ fontSize: 13, color: theme.muted, marginTop: 2 }}>
            {new Date(appt.scheduled_at).toLocaleString(undefined, {
              weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
            {appt.appointment_type ? ` · ${TYPE_LABELS[appt.appointment_type]}` : ''}
            {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
          </div>
          {appt.notes && <div style={{ fontSize: 13, color: theme.muted, marginTop: 6 }}>{appt.notes}</div>}
        </div>
        <button
          onClick={() => onToggle(appt)}
          disabled={busy}
          aria-label={appt.completed ? 'Mark as not done' : 'Mark as done'}
          style={{
            flex: 'none', width: 44, height: 44, borderRadius: 12, cursor: 'pointer',
            border: `1px solid ${appt.completed ? theme.live : theme.line}`,
            background: appt.completed ? theme.live : 'transparent',
            color: theme.text, fontSize: 18,
          }}
        >
          ✓
        </button>
      </div>
    </Card>
  )
}
