# Amelia App — Project Handoff

**This is the first piece of a larger "Family Hub" ecosystem.**
Its own directory, its own Vercel deploy, its own URL — but **not** its
own database. As of ADR 0001 every app in the house shares one Supabase
project. Read `CLAUDE.md` at the repo root first; it is the entry point
for every session and outranks this file.

---

## Where this fits in the bigger picture

Emilio is building a self-hosted home system with several pieces.
This app — **Amelia** — is the first one being built and deployed.

```
┌─────────────────────┐      ┌─────────────────────┐
│  AMELIA APP          │      │  THE HUB             │
│  (this directory)    │      │  27" wall HMI        │
│  baby tracking       │      │  calendar · meals ·  │
│                      │      │  chores · irrigation │
│  own Vercel deploy   │      │  own Vercel deploy   │
└─────────────────────┘      └─────────────────────┘
           │                            │
           │  anon key + user JWT, RLS enforced
           ▼                            ▼
┌─────────────────────────────────────────────────────┐
│  SUPABASE CLOUD — ONE project for the whole house      │
│  schemas: core · baby · calendar · meals · chores ·    │
│           home · ops                                   │
│  Amelia's tables live under `baby`                     │
└─────────────────────────────────────────────────────┘
           ▲                            ▲
           │ service_role               │ outbound only —
           │ (Hub server only)          │ the house dials out,
           │                            │ the cloud never dials in
┌─────────────────────────────────────────────────────┐
│  THE HOUSE — two boxes, not one                        │
│                                                        │
│  NUC — vision/visor, the HMI, meal-prep BPM, house     │
│        control, Brother QL-600 label printer           │
│                                                        │
│  HA Green — Home Assistant: sensors, automations,      │
│        Frigate, Reolink Argus 3 Pro (RTSP local only,  │
│        P2P/cloud disabled on the camera), Aqara via    │
│        ZBT-1, HomeKit bridge. At littleneighborssj.com │
└─────────────────────────────────────────────────────┘
```

> **Open question (FAMILY_HUB.md §4.2):** which of the two boxes derives
> sleep events and calls `/api/ingest` is not decided yet. Earlier
> versions of this file described a single NUC running everything —
> that was wrong.

**Hard rule carried through the whole project:** camera video, images
and audio never leave the house. Only derived events (sleep start/end,
sound alerts) get pushed out.

**Doctor appointments** are logged in this app as a simple input.
Syncing them out to a real shared calendar (CalDAV → iCloud) is
NOT this app's job — that sync logic belongs to the Hub, later. This
app just stores the appointment and exposes a `caldav_uid` column for
whenever that sync gets built.

---

## Current status (as of right now)

- **Git repo on `main`**, with a remote: `origin` points at
  `git@github.com:emireymon09-create/repmonti09.git`. *(This section said
  "no remote configured yet" and "no GitHub repo yet" until 2026-09-20.
  Both were false — verified with `git remote -v`.)*
- **Do not create a second GitHub repo for this directory.** The one that
  exists is the one to use; the monorepo of ADR 0003 is the Hub agent's
  phase 0, and this directory becomes `apps/amelia` inside it.
- **No cloud Supabase project — and this app must not create one.**
  Per ADR 0001 the cloud database is shared and the Hub agent creates
  it. Local development runs against `supabase start` (Docker) as
  before.
- **No Vercel deployment yet.**
- The app runs and is testable on Emilio's machine right now via the
  local Supabase stack.
- **pnpm is the only package manager**, with `pnpm-lock.yaml` committed
  (since 2026-09-20). `npm` and `yarn` abort at `preinstall`.
- **There is a test suite** (Vitest): unit tests run under four system
  timezones, integration tests run against the local Supabase through
  PostgREST with real JWTs — the same path the app uses, which is the
  only path that would have caught the missing-GRANT bug of `0005`.

## What's built

**Database schema** (`supabase/migrations/0001_init.sql`):
- `families`, `family_members` — multi-user support (Emilio + Ana,
  each with their own Supabase Auth login, both linked to one family)
- `babies` — Amelia's profile
- `feedings` — bottle/solid, point-in-time
- `nursing_sessions` — breastfeeding, tracks side (left/right)
- `diaper_changes` — wet/dirty/both
- `growth_measurements` — weight/height over time
- `doctor_appointments` — title, type, scheduled time, doctor name,
  notes, `caldav_uid` (for future Hub sync)
- `monitor_events` — sound alerts / motion events pushed from the NUC
  (event metadata only, never media)
- **Row Level Security enabled on every table** — a user can only
  see/edit data for babies belonging to a family they're a member of

**Auth:** Supabase Auth, email/password, via `/login`

**Dashboard (`/dashboard`)** — the 3am screen. Every control is a
52px-min touch target, and every write surfaces its error instead of
failing silently:
- Breastfeeding: start/stop with a live stopwatch, tracks left/right,
  and suggests the side that wasn't used last
- Bottle (with optional ml) and solids
- Diapers: wet / dirty / both
- Sleep: start/stop with a live stopwatch; a session the NUC opened via
  `/api/ingest` shows as "detected" and can be closed by hand
- Next upcoming appointment

**`/growth`:** add and list measurements. Entry defaults to lb/oz + in
(what the pediatrician's office says out loud) and converts to the
metric the DB stores; a toggle switches to kg/cm. Each row shows both
units and the change since the previous visit.

**`/appointments`:** upcoming and past, add form, tap to mark done.

**Built to the Hub conventions, not around them.** The UI is a Family
Hub surface first and a standalone app second:

- `app/globals.css` — every size, color and radius is a token. The
  27" wall screen is the primary target (`CONVENTIONS.md` §3), so the
  scale tokens re-point above 1180px and the *same components* render
  as a one-handed phone column or as a display readable across the
  living room. Tap targets are 52px on a phone and 84px on the wall,
  against a 44px floor.
- `lib/tokens.ts` — the token set, shaped to move to `packages/ui`.
  No hex anywhere else in the app.
- `lib/db.ts` — the only door to the database. Pages never build a
  query, so the phase-2 move to `schema('baby')` + `household_id` is
  an edit to one file. Anon key under RLS only.
- `lib/types.ts` — one place for row shapes, standing in for the
  generated `packages/db/types`.
- `lib/format.ts` — times render in `America/Los_Angeles` regardless
  of the viewer's clock, relative under a day and absolute past it.
  Unit-tested under four system timezones — `tests/unit/format.test.ts`,
  run with `pnpm test:tz` under `UTC`, `America/Los_Angeles`,
  `Asia/Tokyo` and `Pacific/Kiritimati`. **That sentence was false until
  2026-09-20:** this repo had zero tests in it while claiming otherwise.
- `lib/useBaby.ts` — auth guard + current baby; the place the
  caregiver role check lands in phase 2.
- Dashboard has a **Today** timeline, merged client-side from this
  app's tables. It is shaped to become one read of `core.activity`.

**Installable, and it survives bad wifi.** `app/manifest.ts` +
`public/sw.js` make it an installed app on a phone home screen and a
standalone kiosk on the wall screen. The service worker only caches the
same-origin app shell — never a Supabase response, which would put auth
tokens in a cache on a shared screen.

Writes that can't reach the server are kept on the device
(`lib/queue.ts`, IndexedDB) and replayed in order when it's back. Rows
are inserted with a **client-generated uuid**, which is what lets a
nursing session be started *and* ended offline: the queued update
targets an id we already chose. A server rejection is never queued —
replaying it would just fail again — so it surfaces as an error. Queued
entries show as "not synced yet" everywhere they appear; nothing is
ever presented as saved when it isn't.

**`/api/ingest`:** the one endpoint the NUC will call to push sleep
sessions and monitor events. Authenticates with a shared device
secret (`NUC_DEVICE_SECRET`), NOT a user login, NOT the Supabase
service_role key directly. This endpoint is built but nothing on the
NUC side calls it yet — that HA automation doesn't exist yet.

**`preview.html`:** a standalone, no-setup-needed visual preview of
the dashboard UI (uses temporary browser storage, not the real
database) — useful for quickly showing the design, not for real use.

## What's NOT built yet

- The actual NUC-side HA automation that calls `/api/ingest`
- Retry-queue logic on the HA side for when the NUC has no internet
  (data still logs fine locally in HA either way — this is only about
  keeping the cloud copy in sync once connectivity returns)
- Correcting or retracting a **growth measurement**.
  `growth_measurements` has no UPDATE policy and no `voided_at` column,
  so a mis-typed weight is permanent. Schema change ⇒ proposed in
  `proposals/growth-edit-and-void.md`, demonstrated by a test in
  `tests/integration/rls.test.ts`.

  *(Editing and retracting **every other** logged entry — feedings,
  diapers, nursing, sleep, pumping — IS built, and has been since
  `0006_edit_and_void.sql` plus `updateFeeding`/`voidFeeding` and their
  siblings in `lib/db.ts`. This section claimed otherwise until
  2026-09-20.)*
- Per-device tokens and idempotency on the two device endpoints. A single
  shared secret with `service_role` means whoever holds it can write to
  any family's `baby_id` — two confirmed CRITICAL findings, open on
  purpose because they need new tables ⇒
  `proposals/device-tokens-and-idempotency.md`.
- Automated tests for **components and pages**. What exists covers
  `lib/format.ts`, `lib/queue.ts`, RLS isolation between families, and
  the two device endpoints.
- Lint/format were missing and now exist (`pnpm lint`, `pnpm format`);
  CI to run them does not.
- Anything related to calendar, meal planning, chores, irrigation —
  those belong to the Hub, a separate future project, not this repo

---

## Next steps

1. ~~Init git locally~~ — done, `main`, `.gitignore` in place.
2. **Keep building UI locally** against `supabase start`. Nothing in
   the backend change blocks this, and it is the right thing to be
   doing before Amelia arrives.
3. **Do not create another GitHub repo for this directory.** One remote
   already exists (`emireymon09-create/repmonti09`). The monorepo
   (ADR 0003) is the Hub agent's phase 0; this directory becomes
   `apps/amelia` inside it.
4. **Do not create a cloud Supabase project.** ADR 0001. The shared one
   is the Hub's to create.

### What changes when the shared backend lands (phase 2)

Not action items yet — the Hub agent drives this. Listed so nothing
here gets built in a direction that has to be undone:

- Tables move under a `baby` schema. Queries become
  `supabase.schema('baby').from('feedings')`.
- Every table gains a direct `household_id` column, and RLS switches
  from `is_baby_family_member(baby_id)` to `core.is_member(household_id)`.
  **So: don't add new tables that scope through a `baby_id` join.**
- `babies` becomes a `core.people` row of kind `child`;
  `families` / `family_members` are replaced by `core.households` /
  `core.members` with roles (`owner`, `parent`, `caregiver`, `kid`,
  `viewer`).
- Migrations move to `packages/db/migrations`, numbered by the Hub
  agent. This app stops owning SQL. Propose a migration, don't number
  one.
- Row types come from generated `packages/db/types`, replacing the
  hand-written types in the page components.
- Design tokens move to `packages/ui` — a file move, since
  `lib/tokens.ts` + `app/globals.css` already hold every value and no
  component carries a hex or a raw px.
- The **Today** timeline switches from the client-side merge in
  `lib/db.ts` to a single read of `core.activity`.
- Retraction: house convention is `voided_at` / `voided_by`, not
  deletes. See the mis-tap note below.

## Security posture

- RLS on every table, no exceptions, in the same migration that
  creates the table
- `service_role` key only ever touched server-side
  (`lib/supabaseAdmin.ts`, `/api/ingest`) — never imported into a
  `'use client'` file. **Note:** `CLAUDE.md` §3.4 says the service key
  lives on the *Hub server only*, which this app's `/api/ingest`
  currently contradicts. Flagged as an open question — either ingest
  moves to `apps/hub`, or the rule needs a carve-out.
- Devices authenticate with their own **hashed per-device token** from
  `core.devices`, with an idempotency key on the event — replacing the
  single shared `NUC_DEVICE_SECRET` this app uses today (ADR 0005).
  **Still not implemented.** Written up as
  `proposals/device-tokens-and-idempotency.md`, with a test that
  demonstrates today's cross-family write.
- 2FA on Supabase / Vercel / GitHub accounts, once those exist

### What changed on 2026-09-20

An audit pass (`docs/auditorias/2026-09-20-auditoria-inicial.md`) went
over the whole repo. What it closed:

- **Server-side auth guard.** `middleware.ts` now redirects a signed-out
  visitor away from `/dashboard`, `/pumping`, `/growth`, `/appointments`
  and `/history` before anything renders. RLS is still what protects the
  *data*; this fixes the flash of app shell on a shared wall screen.
- **Device endpoints hardened.** Constant-time secret comparison, a
  ceiling of 20 attempts per minute per source IP, full payload
  validation (uuid, event-type whitelist, `meta` size cap, sane instant
  range), and a malformed body now returns 400 instead of escaping as a
  500. `lib/deviceAuth.ts`.
- **Security headers** in `next.config.mjs`. CSP deliberately left out —
  Next 14 inlines styles and scripts, and a wrong CSP breaks the wall
  screen silently. It goes in separately, report-only first.
- **The offline queue stopped under-reporting itself.** `flushQueue`
  returned `remaining: 0` with a write still queued when a discard came
  before a failure. One line, `lib/queue.ts`.

What it left **open**, on purpose:

- **`/api/quick/nurse` cross-family write (CRITICAL).** It ran with
  `service_role` and picked the oldest `babies` row in the *whole
  database*. Mitigated, not fixed: `QUICK_TOGGLE_BABY_ID` pins the baby,
  and with more than one baby and no variable set the endpoint now
  **fails closed** (409) instead of guessing. The real fix is resolving
  the baby from a device token.
- **`/api/ingest` cross-family write (CRITICAL).** Same root cause; same
  proposal.
- **The local Supabase stack binds to `0.0.0.0`**, not to localhost. On
  the VPS this repo lives on, Studio and the API answer on the public
  interface. Not verified whether a firewall covers it — no sudo. See
  `docs/seguridad-operacional.md` §6.
