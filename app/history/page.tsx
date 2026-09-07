'use client'

import { useCallback, useEffect, useState } from 'react'
import { useBaby } from '@/lib/useBaby'
import { NoBaby } from '@/components/NoBaby'
import { Banner, Card, Grid, Label, Nav, Page } from '@/components/ui'
import { SyncStatus } from '@/components/SyncStatus'
import {
  buildActivity, mergePending, pendingWrites,
  recentDiapers, recentFeedings, recentNursing, recentSleep,
} from '@/lib/db'
import type { ActivityEntry } from '@/lib/types'
import { clockTime, householdToday, longDate } from '@/lib/format'

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

export default function HistoryPage() {
  const { baby, loading } = useBaby()

  const [days, setDays] = useState<Day[]>([])
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async (babyId: string) => {
    const [f, d, n, s, queued] = await Promise.all([
      recentFeedings(babyId, HISTORY_LIMIT), recentDiapers(babyId, HISTORY_LIMIT),
      recentNursing(babyId, HISTORY_LIMIT), recentSleep(babyId, HISTORY_LIMIT),
      pendingWrites(),
    ])

    const firstError = [f, d, n, s].find((r) => r.error)?.error
    if (firstError && navigator.onLine) setErr(`Couldn't load history — ${firstError}`)

    const feedings = mergePending(f.data, 'feedings', queued)
    const diapers = mergePending(d.data, 'diaper_changes', queued)
    const nursing = mergePending(n.data, 'nursing_sessions', queued)
    const sleep = mergePending(s.data, 'sleep_sessions', queued)

    // 0 = the start of time, i.e. no "since today" cutoff — the same
    // merge dashboard uses for Today, just unfiltered.
    const entries = buildActivity(feedings, nursing, diapers, sleep, 0)
    setDays(groupByHouseholdDay(entries))
  }, [])

  useEffect(() => { if (baby) refresh(baby.id) }, [baby, refresh])

  if (loading) return <Page><p className="empty">Loading…</p></Page>
  if (!baby) return <Page><Nav /><NoBaby /></Page>

  return (
    <Page>
      <Nav babyId={baby.id} />
      <h1 className="title">History</h1>
      <SyncStatus />
      {err && <Banner kind="error">{err}</Banner>}

      <Grid>
        {days.length === 0 ? (
          <Card><div className="empty">Nothing logged yet.</div></Card>
        ) : (
          days.map((day) => (
            <Card key={day.key} spanAll>
              <Label>{day.label}</Label>
              <div className="feed">
                {day.entries.map((entry) => (
                  <div className="feed-item" key={`${entry.kind}-${entry.at}`}>
                    <span className="feed-time">{clockTime(entry.at)}</span>
                    <span className="feed-what">
                      <span className="meta">{KIND_LABEL[entry.kind]} · </span>
                      {entry.what}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ))
        )}
      </Grid>
    </Page>
  )
}
