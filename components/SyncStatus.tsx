'use client'

import { useSync } from '@/lib/useSync'
import type { PendingWrite } from '@/lib/queue'
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

/** Drop-in for pages that only need to report state, not read the queue. */
export function SyncStatus() {
  const { online, pending, syncing } = useSync()
  return <SyncBar online={online} pending={pending} syncing={syncing} />
}
