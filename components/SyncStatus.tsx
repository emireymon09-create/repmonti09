'use client'

import { useSync } from '@/lib/useSync'
import { isDeletion, type PendingWrite } from '@/lib/queue'
import { describeWrite, discardPendingPlan } from '@/lib/db'
import { Banner, Btn } from '@/components/ui'
import type { SeenState } from '@/lib/lastSeen'
import { timeAgo } from '@/lib/format'
import { useT } from '@/lib/i18n/react'

export function SyncBar({
  online,
  pending,
  syncing,
}: {
  online: boolean
  pending: PendingWrite[]
  syncing?: boolean
}) {
  const { t } = useT()
  // Connected and nothing waiting: say nothing.
  if (online && pending.length === 0) return null

  const count = pending.length
  const dot = syncing ? 'dot syncing' : online ? 'dot' : 'dot offline'

  let message: string
  if (count === 0) {
    message = t('sync.offline')
  } else if (syncing) {
    message = t('sync.syncing', { count })
  } else if (online) {
    message = t('sync.toSync', { count })
  } else {
    message = t('sync.offlinePending', { count })
  }

  return (
    <div className={count > 0 ? 'syncbar has-pending' : 'syncbar'} role="status">
      <span className={dot} aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}

/**
 * Drop-in for pages that only need to report state, not read the queue.
 * Includes the sync error, so an entry the server rejected — which holds
 * up everything queued behind it — can be seen and discarded from any page.
 */
export function SyncStatus() {
  const { online, pending, syncing, syncError, syncFailed, discardFailed } = useSync()
  return (
    <>
      <SyncBar online={online} pending={pending} syncing={syncing} />
      <SyncErrorBanner error={syncError} failed={syncFailed} onDiscard={discardFailed} />
    </>
  )
}

/**
 * Offline and showing this device's saved copy (lib/lastSeen.ts): say
 * from when, so rows from hours ago are not taken for the current state.
 * The "nothing saved at all" case is each page's own empty state.
 */
export function SeenNote({ state }: { state: SeenState }) {
  const { t, lang } = useT()
  // Not tied to navigator.onLine: with the router up and the internet down
  // the browser says "online" while every read fails, and this copy is
  // exactly what is on screen. A read that works turns the state 'live'.
  if (state.kind !== 'saved') return null
  // Information, not a warning (design.md §5.4): the SyncBar's own look.
  return (
    <div className="syncbar" role="status">
      <span>{t('sync.showingSaved', { when: timeAgo(state.savedAt, Date.now(), lang) })}</span>
    </div>
  )
}

/**
 * "Couldn't sync", when the server rejected a queued entry. The flush has
 * to stop there (order matters), so everything queued behind it waits;
 * this names the entry and offers to discard it — only after a confirm
 * that says what is lost (design.md §5.6). Nothing leaves the queue
 * silently (CLAUDE.md §5.5).
 */
export function SyncErrorBanner({
  error,
  failed,
  onDiscard,
}: {
  error: string | null
  failed: PendingWrite | null
  onDiscard: (ids: string[]) => void
}) {
  const { t, lang } = useT()
  if (!error) return null
  const what = failed ? describeWrite(failed, lang) : null

  async function discard() {
    if (!failed || !what) return
    // The queue as it is now, not as this page last rendered it: another
    // tab may have queued changes to the same row since. What the confirm
    // counts is exactly what gets removed.
    const plan = await discardPendingPlan(failed.id)
    if (plan.length === 0) {
      onDiscard([])
      return
    }
    const count = plan.length - 1
    const message = isDeletion(failed)
      ? t('sync.discardConfirmDelete', { what })
      : count > 0
        ? t('sync.discardConfirmEdits', { what, count })
        : t('sync.discardConfirm', { what })
    if (window.confirm(message)) onDiscard(plan.map((w) => w.id))
  }

  return (
    <Banner kind="error">
      {t('common.couldNotSync', { error })}
      {failed && what && (
        <>
          <div className="meta">
            {t('sync.rejected', { what, when: timeAgo(failed.queuedAt, Date.now(), lang) })}
          </div>
          <div className="row-tight">
            <Btn variant="quiet" onClick={discard}>
              {t('sync.discard')}
            </Btn>
          </div>
        </>
      )}
    </Banner>
  )
}
