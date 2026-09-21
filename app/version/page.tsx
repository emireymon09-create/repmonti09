import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Card, Grid, Label, Nav, Page } from '@/components/ui'
import { parseChangelog } from '@/lib/changelog'
import { measuredOn } from '@/lib/format'
import { APP_VERSION } from '@/lib/version'

// Se arma en el build: CHANGELOG.md no cambia entre deploys.
export const dynamic = 'force-static'

export default function VersionPage() {
  const releases = parseChangelog(readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8'))

  return (
    <Page>
      <Nav />
      <h1 className="title">Version history</h1>
      <Grid>
        <Card spanAll>
          <Label>Current version</Label>
          <div className="value">v{APP_VERSION}</div>
        </Card>
        {releases.map((r) => (
          <Card key={r.version} spanAll>
            <Label>
              v{r.version} · {measuredOn(r.date)}
            </Label>
            {r.summary && <div className="meta">{r.summary}</div>}
            <div className="feed">
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
