'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Btn, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import {
  buildActivity,
  mergePending,
  pendingWrites,
  recentDiapers,
  recentFeedings,
  recentNursing,
  recentSleep,
  updateDiaper,
  updateFeeding,
  updateNursing,
  updateSleep,
  voidDiaper,
  voidFeeding,
  voidNursing,
  voidSleep,
} from '@/lib/db'
import { useVolumeUnit } from '@/lib/useVolumeUnit'
import type {
  ActivityEntry,
  DiaperChange,
  DiaperType,
  Feeding,
  FeedingType,
  NursingSession,
  Side,
  SleepSession,
  WithPending,
} from '@/lib/types'
import {
  clockTime,
  fromHouseholdInputValue,
  householdToday,
  longDate,
  mlToUnit,
  toHouseholdInputValue,
  unitToMl,
} from '@/lib/format'

const HISTORY_LIMIT = 200

/** One calendar day's worth of entries, household timezone. */
type Day = { key: string; label: string; entries: ActivityEntry[] }

/**
 * Every logged entry has an ISO `at` already — the household day it
 * falls on is just householdToday() run on that instant instead of
 * "now". Entries arrive newest-first (buildActivity's own sort), so
 * grouping in order naturally keeps days newest-first too.
 */
function groupByHouseholdDay(entries: ActivityEntry[]): Day[] {
  const days: Day[] = []
  const byKey = new Map<string, Day>()

  for (const entry of entries) {
    const key = householdToday(new Date(entry.at))
    let day = byKey.get(key)
    if (!day) {
      day = { key, label: longDate(entry.at), entries: [] }
      byKey.set(key, day)
      days.push(day)
    }
    day.entries.push(entry)
  }

  return days
}

const KIND_LABEL: Record<ActivityEntry['kind'], string> = {
  feeding: 'Feeding',
  nursing: 'Nursing',
  diaper: 'Diaper',
  sleep: 'Sleep',
  growth: 'Growth',
}

/** Only these four kinds have a raw row + edit/void functions behind them. */
type EditKind = 'feeding' | 'diaper' | 'nursing' | 'sleep'
type EditTarget = { kind: EditKind; id: string }

function isEditable(kind: ActivityEntry['kind']): kind is EditKind {
  return kind === 'feeding' || kind === 'diaper' || kind === 'nursing' || kind === 'sleep'
}

export default function HistoryPage() {
  const { baby, loading } = useBaby()
  const [unit] = useVolumeUnit()

  const [days, setDays] = useState<Day[]>([])
  const [feedings, setFeedings] = useState<WithPending<Feeding>[]>([])
  const [diapers, setDiapers] = useState<WithPending<DiaperChange>[]>([])
  const [nursing, setNursing] = useState<WithPending<NursingSession>[]>([])
  const [sleep, setSleep] = useState<WithPending<SleepSession>[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [editing, setEditing] = useState<EditTarget | null>(null)

  // One small set of form fields, shared across kinds — only the ones
  // relevant to the entry being edited are ever shown or read.
  const [fType, setFType] = useState<FeedingType>('bottle')
  const [fAmount, setFAmount] = useState('')
  const [fAt, setFAt] = useState('')
  const [dType, setDType] = useState<DiaperType>('both')
  const [dAt, setDAt] = useState('')
  const [nSide, setNSide] = useState<Side>('left')
  const [nStart, setNStart] = useState('')
  const [nEnd, setNEnd] = useState('')
  const [sStart, setSStart] = useState('')
  const [sEnd, setSEnd] = useState('')

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    },
    [],
  )

  function confirm(message: string) {
    setFlash(message)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2500)
  }

  const refresh = useCallback(
    async (babyId: string) => {
      const [f, d, n, s, queued] = await Promise.all([
        recentFeedings(babyId, HISTORY_LIMIT),
        recentDiapers(babyId, HISTORY_LIMIT),
        recentNursing(babyId, HISTORY_LIMIT),
        recentSleep(babyId, HISTORY_LIMIT),
        pendingWrites(),
      ])

      const firstError = [f, d, n, s].find((r) => r.error)?.error
      if (firstError && navigator.onLine) setErr(`Couldn't load history — ${firstError}`)

      const mFeedings = mergePending(f.data, 'feedings', queued)
      const mDiapers = mergePending(d.data, 'diaper_changes', queued)
      const mNursing = mergePending(n.data, 'nursing_sessions', queued)
      const mSleep = mergePending(s.data, 'sleep_sessions', queued)

      setFeedings(mFeedings)
      setDiapers(mDiapers)
      setNursing(mNursing)
      setSleep(mSleep)

      // 0 = the start of time, i.e. no "since today" cutoff — the same
      // merge dashboard uses for Today, just unfiltered.
      const entries = buildActivity(mFeedings, mNursing, mDiapers, mSleep, 0, unit)
      setDays(groupByHouseholdDay(entries))
    },
    [unit],
  )

  useEffect(() => {
    if (baby) refresh(baby.id)
  }, [baby, refresh])

  function startEdit(entry: ActivityEntry) {
    if (!isEditable(entry.kind)) return
    setErr(null)

    if (entry.kind === 'feeding') {
      const row = feedings.find((r) => r.id === entry.id)
      if (!row) return
      setFType(row.feeding_type)
      setFAmount(row.amount_ml != null ? String(mlToUnit(row.amount_ml, unit)) : '')
      setFAt(toHouseholdInputValue(new Date(row.fed_at)))
    } else if (entry.kind === 'diaper') {
      const row = diapers.find((r) => r.id === entry.id)
      if (!row) return
      setDType(row.diaper_type)
      setDAt(toHouseholdInputValue(new Date(row.changed_at)))
    } else if (entry.kind === 'nursing') {
      const row = nursing.find((r) => r.id === entry.id)
      if (!row || !row.ended_at) return
      setNSide(row.side)
      setNStart(toHouseholdInputValue(new Date(row.started_at)))
      setNEnd(toHouseholdInputValue(new Date(row.ended_at)))
    } else {
      const row = sleep.find((r) => r.id === entry.id)
      if (!row || !row.ended_at) return
      setSStart(toHouseholdInputValue(new Date(row.started_at)))
      setSEnd(toHouseholdInputValue(new Date(row.ended_at)))
    }

    setEditing({ kind: entry.kind, id: entry.id })
  }

  async function saveEdit() {
    if (!editing || !baby || busy) return
    setBusy(true)
    setErr(null)

    let result: { error: string | null }

    if (editing.kind === 'feeding') {
      const amount = fAmount.trim() === '' ? null : Number(fAmount)
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        setErr(`Amount has to be a number of ${unit}.`)
        setBusy(false)
        return
      }
      result = await updateFeeding(editing.id, {
        feeding_type: fType,
        amount_ml: fType === 'bottle' && amount !== null ? unitToMl(amount, unit) : null,
        fed_at: fromHouseholdInputValue(fAt),
      })
    } else if (editing.kind === 'diaper') {
      result = await updateDiaper(editing.id, {
        diaper_type: dType,
        changed_at: fromHouseholdInputValue(dAt),
      })
    } else if (editing.kind === 'nursing') {
      result = await updateNursing(editing.id, {
        side: nSide,
        started_at: fromHouseholdInputValue(nStart),
        ended_at: fromHouseholdInputValue(nEnd),
      })
    } else {
      result = await updateSleep(editing.id, {
        started_at: fromHouseholdInputValue(sStart),
        ended_at: fromHouseholdInputValue(sEnd),
      })
    }

    if (result.error) {
      setErr(`Couldn't save — ${result.error}`)
    } else {
      setEditing(null)
      confirm('Saved')
      await refresh(baby.id)
    }
    setBusy(false)
  }

  async function deleteEntry(entry: ActivityEntry) {
    if (!baby || busy || !isEditable(entry.kind)) return
    if (!window.confirm('Remove this entry from History? Nothing else changes.')) return

    const { kind, id } = entry
    setBusy(true)
    setErr(null)

    const result =
      kind === 'feeding'
        ? await voidFeeding(id)
        : kind === 'diaper'
          ? await voidDiaper(id)
          : kind === 'nursing'
            ? await voidNursing(id)
            : await voidSleep(id)

    if (result.error) {
      setErr(`Couldn't delete — ${result.error}`)
    } else {
      if (editing?.id === id) setEditing(null)
      confirm('Deleted')
      await refresh(baby.id)
    }
    setBusy(false)
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
      <h1 className="title">History</h1>
      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}
      {flash && !err && <Banner kind="ok">{flash}</Banner>}

      <Grid>
        {days.length === 0 ? (
          <Card>
            <div className="empty">Nothing logged yet.</div>
          </Card>
        ) : (
          days.map((day) => (
            <Card key={day.key} spanAll>
              <Label>{day.label}</Label>
              <div className="feed">
                {day.entries.map((entry) => {
                  const isEditing = editing?.kind === entry.kind && editing.id === entry.id
                  return (
                    <div key={`${entry.kind}-${entry.id}`}>
                      <div className="feed-item">
                        <span className="feed-time">{clockTime(entry.at)}</span>
                        <span className="feed-what">
                          <span className="meta">{KIND_LABEL[entry.kind]} · </span>
                          {entry.what}
                        </span>
                        {isEditable(entry.kind) && !isEditing && (
                          <span className="feed-actions">
                            <button
                              type="button"
                              className="linkish"
                              disabled={busy || editing !== null}
                              onClick={() => startEdit(entry)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="linkish"
                              disabled={busy || editing !== null}
                              onClick={() => deleteEntry(entry)}
                            >
                              Delete
                            </button>
                          </span>
                        )}
                      </div>

                      {isEditing && editing.kind === 'feeding' && (
                        <div className="edit-panel">
                          <div className="row">
                            {(['bottle', 'solid', 'nursing'] as FeedingType[]).map((t) => (
                              <Btn
                                key={t}
                                variant={fType === t ? 'action' : 'quiet'}
                                onClick={() => setFType(t)}
                              >
                                {t[0].toUpperCase() + t.slice(1)}
                              </Btn>
                            ))}
                          </div>
                          {fType === 'bottle' && (
                            <input
                              className="input narrow"
                              value={fAmount}
                              onChange={(e) => setFAmount(e.target.value)}
                              inputMode="decimal"
                              placeholder={unit}
                              aria-label={`Amount in ${unit}`}
                            />
                          )}
                          <input
                            type="datetime-local"
                            className="input"
                            value={fAt}
                            onChange={(e) => setFAt(e.target.value)}
                            max={toHouseholdInputValue()}
                            aria-label="Time it happened"
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              Save
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              Cancel
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'diaper' && (
                        <div className="edit-panel">
                          <div className="row">
                            {(['wet', 'dirty', 'both'] as DiaperType[]).map((t) => (
                              <Btn
                                key={t}
                                variant={dType === t ? 'action' : 'quiet'}
                                onClick={() => setDType(t)}
                              >
                                {t[0].toUpperCase() + t.slice(1)}
                              </Btn>
                            ))}
                          </div>
                          <input
                            type="datetime-local"
                            className="input"
                            value={dAt}
                            onChange={(e) => setDAt(e.target.value)}
                            max={toHouseholdInputValue()}
                            aria-label="Time it happened"
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              Save
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              Cancel
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'nursing' && (
                        <div className="edit-panel">
                          <div className="row">
                            {(['left', 'right'] as Side[]).map((s) => (
                              <Btn
                                key={s}
                                variant={nSide === s ? 'action' : 'quiet'}
                                onClick={() => setNSide(s)}
                              >
                                {s[0].toUpperCase() + s.slice(1)}
                              </Btn>
                            ))}
                          </div>
                          <label className="label" htmlFor="nursing-start">
                            Started
                          </label>
                          <input
                            id="nursing-start"
                            type="datetime-local"
                            className="input"
                            value={nStart}
                            onChange={(e) => setNStart(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <label className="label" htmlFor="nursing-end">
                            Ended
                          </label>
                          <input
                            id="nursing-end"
                            type="datetime-local"
                            className="input"
                            value={nEnd}
                            onChange={(e) => setNEnd(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              Save
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              Cancel
                            </Btn>
                          </div>
                        </div>
                      )}

                      {isEditing && editing.kind === 'sleep' && (
                        <div className="edit-panel">
                          <label className="label" htmlFor="sleep-start">
                            Started
                          </label>
                          <input
                            id="sleep-start"
                            type="datetime-local"
                            className="input"
                            value={sStart}
                            onChange={(e) => setSStart(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <label className="label" htmlFor="sleep-end">
                            Ended
                          </label>
                          <input
                            id="sleep-end"
                            type="datetime-local"
                            className="input"
                            value={sEnd}
                            onChange={(e) => setSEnd(e.target.value)}
                            max={toHouseholdInputValue()}
                          />
                          <div className="row-tight">
                            <Btn disabled={busy} onClick={saveEdit}>
                              Save
                            </Btn>
                            <Btn variant="quiet" onClick={() => setEditing(null)}>
                              Cancel
                            </Btn>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </Card>
          ))
        )}
      </Grid>
    </Page>
  )
}
