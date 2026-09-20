'use client'

import { useSync } from '@/lib/useSync'
import type { PendingWrite } from '@/lib/queue'

export function SyncBar({
  online,
  pending,
  syncing,
}: {
  online: boolean
  pending: PendingWrite[]
  syncing?: boolean
}) {
  // Connected and nothing waiting: say nothing.
  if (online && pending.length === 0) return null

  const count = pending.length
  const dot = syncing ? 'dot syncing' : online ? 'dot' : 'dot offline'

  let message: string
  if (count === 0) {
    message = 'Offline. Anything you log is kept on this device.'
  } else if (syncing) {
    message = `Syncing ${count} ${count === 1 ? 'entry' : 'entries'}…`
  } else if (online) {
    message = `${count} ${count === 1 ? 'entry' : 'entries'} still to sync.`
  } else {
    message = `Offline · ${count} ${count === 1 ? 'entry' : 'entries'} saved on this device, not synced yet.`
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
