'use client'

import { Card, Grid, Label, Nav, Page } from '@/components/ui'
import type { Release } from '@/lib/changelog'
import { measuredOn } from '@/lib/format'
import { useT } from '@/lib/i18n/react'
import { APP_VERSION } from '@/lib/version'

/**
 * The /version screen. The page itself stays a server component — it reads
 * CHANGELOG.md at build time — and hands the parsed releases here, so the
 * chrome and the dates can follow the interface language. The release notes
 * are CHANGELOG content, written in English, and shown as written.
 */
export function VersionHistory({ releases }: { releases: Release[] }) {
  const { t, lang } = useT()

  return (
    <Page>
      <Nav />
      <h1 className="title">{t('version.title')}</h1>
      <Grid>
        <Card spanAll>
          <Label>{t('version.current')}</Label>
          <div className="value">v{APP_VERSION}</div>
          {lang !== 'en' && <div className="meta">{t('version.notesLanguage')}</div>}
        </Card>
        {releases.map((r) => (
          <Card key={r.version} spanAll>
            <Label>
              v{r.version} · {measuredOn(r.date, lang)}
            </Label>
            {r.summary && (
              <div className="meta" lang="en">
                {r.summary}
              </div>
            )}
            <div className="feed" lang="en">
              {r.changes.map((change) => (
                <div key={change} className="feed-item">
                  <span className="feed-what">{change}</span>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </Grid>
    </Page>
  )
}
