'use client'

import { Card } from '@/components/ui'
import { useT } from '@/lib/i18n/react'

export function NoBaby() {
  const { t } = useT()
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
