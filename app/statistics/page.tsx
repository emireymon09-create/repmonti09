'use client'

import { EmptyState, Nav, Page } from '@/components/ui'
import { useT } from '@/lib/i18n/react'

/**
 * Statistics — el futuro tablero de gráficas.
 *
 * Hoy no dibuja nada y lo dice: es un destino real de la barra de abajo, con
 * su nav, su título y un estado vacío que cuenta qué va a aparecer acá y dónde
 * están mientras tanto los totales (en cada página de sección). No promete
 * fecha: §5.5 del proyecto vale también para lo que todavía no existe.
 *
 * No lee nada, así que no tiene estado de carga ni puede quedarse sin marco.
 */
export default function StatisticsPage() {
  const { t } = useT()

  return (
    <Page>
      <Nav />
      <h1 className="title">{t('stats.title')}</h1>
      <div className="empty-fill">
        <EmptyState icon="statistics" title={t('stats.empty')} hint={t('stats.emptyHint')} />
      </div>
    </Page>
  )
}
