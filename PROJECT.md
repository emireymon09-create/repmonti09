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
- **Deployed on Vercel (Hobby plan), with auto-deploy on every push to
  `main`.** *(Corrected 2026-09-22. This section said "No Vercel
  deployment yet" — false.)* There is no manual deploy step: pushing to
  `main` publishes. That is why the version bump + CHANGELOG entry of
  `CLAUDE.md` §0.1 is mandatory on every push — it is the only record of
  what went out.
- **A cloud Supabase project exists and is what production uses.**
  *(Corrected 2026-09-22. This section said "No cloud Supabase project —
  and this app must not create one" — false.)* What is still true: **do
  not create a second one.** ADR 0001's shared household database is a
  phase-2 question, not a reason to pretend this one does not exist.
- **This VPS and its Docker stack are development and testing only** —
  they never were and never will be production infrastructure. Local
  development runs against a self-owned `docker-compose.yml` in
  `supabase/docker/`, operated with `pnpm db:up` / `db:env` /
  `db:reset` / `db:down` — not the Supabase CLI, which could not be made
  to bind to anything but `0.0.0.0`.
- **A migration applied locally is NOT applied in production.** The two
  databases are separate. Applying a migration to the cloud project is a
  deliberate, separate step.
- **Verified on 2026-09-22**, with the `gh` CLI (authenticated on this
  VPS) and public requests — not on anyone's word: the Vercel project is
  `emireymon09-create/amelia-app`; every push to `main` produces a
  `Production` deployment (12 of them, the last one 56 seconds after
  commit `95a86cd`); the stable production URL is
  `https://amelia-app.vercel.app`; and the cloud Supabase project is
  `https://ituurekoybqjqpuycweh.supabase.co` (that value ships in the
  public client bundle — `NEXT_PUBLIC_SUPABASE_URL` is inlined at build
  time). See `CLAUDE.md` §2.1 for the table.
- **Still not verified — ask Luis:** the Vercel plan tier, the Supabase
  plan and region, whether the three VAPID variables are set in Vercel,
  whether 2FA is on, and **whether migrations 0009/0010/0011 are applied
  in the cloud**. That last one needs SQL access to the cloud project,
  and this machine has none (no `.vercel/`, no Supabase CLI, no
  `~/.supabase/access-token`, and `.env.local` points at `127.0.0.1`).
  Do not invent them.
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
- `push_subscriptions` (`0009`) — one row per browser that asked for
  nursing alerts, scoped by `family_id` directly, visible only to the
  parent who created it
- **Row Level Security enabled on every table** — 13 of them as of
  `0009` — a user can only see/edit data for babies belonging to a
  family they're a member of

**Auth:** Supabase Auth, email/password, via `/login`

**Dashboard (`/dashboard`)** — the 3am screen, **three cards since
2026-09-22**: Feeding, Diaper, Sleep. Every control is a 52px-min touch
target, and every write surfaces its error instead of failing silently:
- Feeding: breastfeeding start/stop with a live stopwatch (tracks
  left/right, suggests the side that wasn't used last), bottle with
  optional ml, and solids. The card's line is the most recent of the
  two — a bottle or a finished nursing session
- Diapers: wet / dirty / both
- Sleep: start/stop with a live stopwatch; a session the NUC opened via
  `/api/ingest` shows as "detected" and can be closed by hand
- Each card's corner button opens its section page. The "Totals and log →"
  foot the cards used to carry was removed on 2026-09-23: the arrow already
  says it, and the line pushed the buttons down on every card

What **left** the dashboard on 2026-09-22: the Today timeline (it still
exists — `buildActivity`, now read by `/history` and by the section
pages), the next-appointment card (Doctor has it) and "Log a missed
session" (see the section pages below). "Next feeding" is no longer
predicted while a nursing session is running.

**`/feeding`, `/diapers`, `/sleep`** (2026-09-22) — one shared screen,
`components/SectionPage.tsx`, three 7-line pages:
- Totals for **today** and the **last 7 days** (today plus the 6 days
  before it, household timezone): feedings by kind, bottle total, time
  at the breast; diapers by kind; time asleep and naps. The maths is
  `lib/kpis.ts`, pure functions with no clock and no database, so it is
  unit-tested under four timezones. A session counts for the part of it
  that falls inside the window, so last night's sleep gives today its
  hours after midnight
- The full log underneath, with per-entry edit and delete (soft-delete
  via `voided_at`, one panel open at a time, focus returns to Edit)
- **"Log a past one"**: one entry with the time it really happened, and
  for sessions a "Finished / Still going" choice — "Still going" opens a
  session that started a while ago and is blocked if one is already
  running
- Reads are `feedingsSince` / `nursingSince` / `diapersSince` /
  `sleepSince` in `lib/db.ts`, with **no `limit`** (a total cut at the
  newest N rows would be quietly wrong)
- All three are in `middleware.ts`, in `lib/offlinePages.ts` and in the
  service worker's precache (`amelia-v4`), so they open offline like the
  rest

**Nursing alerts** (2026-09-22) — a web push notification when a nursing
session has been running for 30 minutes and nobody stopped it:
- Migration `0009_push.sql`: `push_subscriptions` (RLS and GRANTs in the
  same migration, scoped by `family_id` directly — the phase-2 shape),
  `nursing_sessions.long_alert_sent_at`, and a `push_check` scope on
  `device_tokens`
- Turned on per device from **Settings** (`/settings`, since 2026-09-23;
  it was in the gear menu before) (`components/NursingAlerts.tsx`); it says "On" only once the browser
  subscription and the server row both exist, and explains itself where
  it can't be turned on (no push support, iOS before the app is
  installed, notifications blocked, server without keys)
- `/api/push/subscription` runs as the signed-in parent (anon key +
  session cookies, `lib/supabaseRoute.ts`) so everything goes through
  RLS. `/api/push/nursing-check` runs with `service_role` and
  authenticates with a per-device token of scope `push_check`
- Sent **once per session**: an atomic
  `update … where long_alert_sent_at is null returning` claims it, and
  if no send succeeded the mark is released so the next check retries
- The notification is written in the language stored with each
  subscription, since the app may be closed when it arrives
- **Nothing calls the check yet** — see "What's NOT built yet"

**`/growth`:** add and list measurements, edit and delete per entry.
Entry defaults to lb/oz + in (what the pediatrician's office says out
loud) and converts to the metric the DB stores; a toggle switches to
kg/cm. Each row shows both units and the change since the previous
visit. Editing keeps a field the parent didn't touch at its exact
stored value instead of re-deriving it from rounded lb/oz. Deleting is
a soft-delete (`voided_at`, 0008): the entry stops counting toward the
growth curve but the row stays in the database.

**`/appointments`:** upcoming and past, add form, tap to mark done.

**`/settings`** (2026-09-23): theme, language, nursing alerts, the oz/ml
switch, "Reset milk total" and signing out. All six used to live inside the
Menu's drop-down, which was navigation and control panel at once; none of them
is left there. The Menu is now a single-column list of the eight other screens,
with the version number at its foot.

**`/version`:** the current version and the full change history, read from
`CHANGELOG.md` and `package.json`'s `version` field — reachable from the
version number at the foot of the Menu. `tests/unit/changelog.test.ts` fails if the two
ever disagree.

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
- The **activity timeline** is merged client-side from this app's
  tables (`buildActivity` in `lib/db.ts`) and is shaped to become one
  read of `core.activity`. It used to be the dashboard's "Today"; since
  2026-09-22 it is what `/history` and the three section pages render.

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
sessions and monitor events. Authenticates with its own per-device
token (`device_tokens`, `0007`, looked up by hash), NOT a user login,
NOT the Supabase service_role key directly on the device. The baby it
writes to is resolved from the token — it can never leave that token's
family. This endpoint is built but nothing on the NUC side calls it
yet — that HA automation doesn't exist yet.

**`preview.html`:** a standalone, no-setup-needed visual preview of
the dashboard UI (uses temporary browser storage, not the real
database) — useful for quickly showing the design, not for real use.

## What's NOT built yet

- The actual NUC-side HA automation that calls `/api/ingest`
- Retry-queue logic on the HA side for when the NUC has no internet
  (data still logs fine locally in HA either way — this is only about
  keeping the cloud copy in sync once connectivity returns)

  *(Editing and retracting logged entries — feedings, diapers, nursing,
  sleep, pumping, and now growth measurements (`0008`) — IS built.
  `lib/db.ts` has `update*`/`void*` for all of them.)*
- **The minute-by-minute trigger for `/api/push/nursing-check`, *applied
  in the cloud*.** The caller was decided on 2026-09-22 — `pg_cron` +
  `pg_net` inside the cloud Supabase project — and the migration is
  written (`supabase/migrations/0011_push_cron.sql`). The VPS was ruled
  out (not production) and so was Vercel Cron (Hobby runs once a day,
  with up to ~59 minutes of drift — useless for a 30-minute threshold).
  **But it has not been applied to the cloud project, because this VPS
  has no credentials for it**, so the nursing alert still does not
  arrive on its own. What is missing is listed in `CLAUDE.md` §7.6.
- What this server **cannot** test about push, and therefore is not
  claimed to work: Chrome stable and Android, APNs/iOS (including the
  "add to Home Screen" flow), Firefox, a locked phone or a closed app,
  TTL and `Topic` with the device disconnected, deletion on 404/410
  against a real push service, and the notification **click** itself
  (`clients.focus()`/`openWindow()` are refused without a real user
  gesture). What was tested end to end is full Chromium against the real
  push service.
- Idempotency on the two device endpoints. A retried request (the NUC's
  HA automation, or a double-tap on the Shortcut) still writes twice —
  two rows in `monitor_events`, or two open sleep/nursing sessions ⇒
  `proposals/device-tokens-and-idempotency.md` §4.
- **The phone's bottom bar is two items** since 2026-09-22 — Today and Menu —
  with the other eight screens inside the menu's "Go to" group. Feeding,
  Diapers and Sleep had no navigation entry at all before that. The tablet and
  wall nav is unchanged. Details and the measurements in `design.md` §5.11.
- **A page's loading state renders the nav too** since 2026-09-22. It used to
  return a bare page, so every navigation emptied the whole window, bottom bar
  included — that was the "flash" between screens (`design.md` §5.13).
- **The 403 retry policy for push** (`0010` + `lib/push/retry.ts`): a
  subscription the push service rejects three checks in a row is deleted, but
  only while other subscriptions in the same batch are being delivered. If all
  of them fail at once, nothing is deleted and it is logged as a probable
  server-side VAPID misconfiguration.
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
2. **Keep building UI locally** against `pnpm db:up` (the self-owned
   stack in `supabase/docker/`). Nothing in the backend change blocks
   this, and it is the right thing to be doing before Amelia arrives.
3. **Do not create another GitHub repo for this directory.** One remote
   already exists (`emireymon09-create/repmonti09`). The monorepo
   (ADR 0003) is the Hub agent's phase 0; this directory becomes
   `apps/amelia` inside it.
4. **Do not create a *second* cloud Supabase project.** One already
   exists and production uses it (corrected 2026-09-22 — this line used
   to say there was none). ADR 0001's shared household database is still
   the Hub's to create, in phase 2.

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
  one. `0007` and `0008` were numbered in this repo by explicit
  request; they enter the Hub as history.
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
- Devices authenticate with their own **hashed per-device token**
  (`device_tokens`, ADR 0005). **Implemented in `0007`** (21 sep 2026):
  each token belongs to one family, is optionally pinned to one baby,
  and carries scopes (`ingest`, `quick_nurse`, and `push_check` since
  `0009`). The baby a device writes
  to is resolved from the token and can never leave its family — closes
  findings C1 and C2. An idempotency key on the event is still not
  implemented; written up as
  `proposals/device-tokens-and-idempotency.md` §4.
- **Push keys (2026-09-22).** The VAPID pair is split on purpose:
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is genuinely public (the browser needs
  it to subscribe), while `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are
  **server-only** and never carry the `NEXT_PUBLIC_` prefix. They are
  read only from `lib/push/server.ts`, which route handlers import and
  no `'use client'` file can. Locally `pnpm db:env` generates the pair
  with `scripts/vapid-keys.mjs` **only if it is missing** — overwriting
  it would silently kill every subscription made with the old one.
- **`push_subscriptions` is scoped by `family_id` directly** (not a join
  through `baby_id` — the phase-2 shape), with RLS in the same migration
  that creates it: each parent sees, changes and deletes only their own
  rows, and only within a family they belong to. The other parent in the
  same family cannot read this phone's endpoint. `anon` is revoked
  everything; `authenticated` gets exactly select/insert/update/delete.
  The endpoint URL is validated against an allowlist of push services
  both when it is stored and before anything is sent to it, because the
  server makes a POST to that URL (anti-SSRF), and a row written
  straight through PostgREST never passes through the app's route.
- 2FA on the Supabase, Vercel and GitHub accounts. All three exist now
  (corrected 2026-09-22 — this line said "once those exist"), so this is
  an open action item, not a future one. **Not verified from this VPS**
  whether 2FA is on — ask Luis.

### What changed on 2026-09-20

An audit pass (`docs/auditorias/2026-09-20-auditoria-inicial.md`) went
over the whole repo. What it closed:

- **Server-side auth guard.** `middleware.ts` now redirects a signed-out
  visitor away from `/dashboard`, `/pumping`, `/growth`, `/appointments`
  and `/history` — and, since 2026-09-22, `/feeding`, `/diapers` and
  `/sleep` — before anything renders. RLS is still what protects the
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

- **Resolved 2026-09-21.** `/api/quick/nurse` and `/api/ingest`
  cross-family write (CRITICAL, C1 and C2). Both ran with `service_role`
  and either picked the oldest `babies` row in the whole database or
  trusted a `baby_id` from the request body — with a secret shared by
  the whole install, neither one knew *whose* family it was writing to.
  Fixed by `device_tokens` (`0007`): the baby a device writes to is now
  resolved from its own token and can never leave that token's family.
  Demonstrated closed in `tests/integration/{ingest,quick-nurse}.test.ts`.
- **Resolved 2026-09-21.** The local stack used to bind to `0.0.0.0`
  (the Supabase CLI has no config key for the bind — traced into the
  binary, see `docs/superpowers/plans/2026-09-21-tokens-crecimiento-stack-versiones.md`
  evidence E-3). Replaced with a self-owned `docker-compose.yml` in
  `supabase/docker/` that publishes every port as `127.0.0.1:port:port`.
  `pnpm db:status` and `ss -tln` confirm only `127.0.0.1`, no `0.0.0.0`.
  See `docs/seguridad-operacional.md` §6.
