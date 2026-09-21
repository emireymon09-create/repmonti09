import { readFileSync } from 'node:fs'
import path from 'node:path'
import { VersionHistory } from '@/components/VersionHistory'
import { parseChangelog } from '@/lib/changelog'

// Se arma en el build: CHANGELOG.md no cambia entre deploys.
export const dynamic = 'force-static'

export default function VersionPage() {
  const releases = parseChangelog(readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8'))
  return <VersionHistory releases={releases} />
}
