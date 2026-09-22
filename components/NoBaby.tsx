'use client'

import { Card } from '@/components/ui'
import { useT } from '@/lib/i18n/react'

/**
 * No baby to show. `offline`: the server couldn't be asked and this device
 * has nothing saved (lib/useBaby.ts) — which is not the same as the family
 * having no baby profile, so it doesn't say that.
 */
export function NoBaby({ offline = false }: { offline?: boolean }) {
  const { t } = useT()
  if (offline) {
    return (
      <Card>
        <p className="empty">{t('sync.nothingSaved')}</p>
      </Card>
    )
  }
  return (
    <Card>
      <p className="lead">{t('noBaby.lead')}</p>
      <p className="note">
        {t('noBaby.note1')} <code>family_members</code> {t('noBaby.note2')} <code>family_id</code>
        {t('noBaby.note3')}
      </p>
    </Card>
  )
}
