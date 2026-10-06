// Read EVERY row of a query, a page at a time.
//
// Supabase in the cloud caps each PostgREST response at `max_rows` (1000 by
// default) — silently: no error, no header the client checks, just the first
// 1000 rows. The local stack has no cap, so a read "with no limit" that adds
// things up looks right here and comes up short in production. Every read in
// lib/db.ts whose cut would lie (a total, the stash, a curve, the inputs of an
// estimate) goes through this.
//
// How: `.range(from, to)` in pages of PAGE_SIZE until a page comes back short.
// The query MUST be ordered by something unique (add `.order('id')` as the last
// tie-break): with ties, Postgres may hand back the tied rows in a different
// order on each request, and offset paging would skip some and repeat others.
//
// PAGE_SIZE is 1000 because that is Supabase's default max_rows. If the
// project's max_rows is ever set LOWER than this, a full page would look short
// and the read would stop early — lower PAGE_SIZE with it.
//
// A row that moves between two requests (someone wrote a newer one in the
// middle) can show up at the end of one page and the start of the next: it is
// kept once, by `id`. A row voided between two requests can shift the next
// page up by one and be skipped; that window is milliseconds and only exists
// past 1000 rows.

export const PAGE_SIZE = 1000

type Page<T> = { data: T[] | null; error: unknown }

export async function readAll<T extends { id?: unknown }, E = unknown>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: E | null }>,
  pageSize: number = PAGE_SIZE,
): Promise<{ data: T[]; error: E | null }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('readAll: bad page size')
  const out: T[] = []
  const seen = new Set<unknown>()
  for (let from = 0; ; from += pageSize) {
    const { data, error } = (await page(from, from + pageSize - 1)) as Page<T> & { error: E | null }
    // Half a total is worse than none: on an error the caller gets the error
    // and nothing else, exactly like the single read it replaces.
    if (error) return { data: [], error }
    const rows = data ?? []
    for (const row of rows) {
      const key = row.id
      if (key != null) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      out.push(row)
    }
    if (rows.length < pageSize) return { data: out, error: null }
  }
}
