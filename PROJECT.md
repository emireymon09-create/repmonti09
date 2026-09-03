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

- **Local git repo initialized** on `main`, scaffold committed.
  No remote configured yet.
- **No GitHub repo yet.**
- **No cloud Supabase project — and this app must not create one.**
  Per ADR 0001 the cloud database is shared and the Hub agent creates
  it. Local development runs against `supabase start` (Docker) as
  before.
- **No Vercel deployment yet.**
- The app runs and is testable on Emilio's machine right now via the
  local Supabase stack.

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

**Shared bits:** `lib/format.ts` (time/unit formatting, unit-tested),
`lib/useBaby.ts` (auth guard + current baby), `components/ui.tsx`
(palette and controls, so the pages can't drift apart)

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
- Editing or deleting a logged entry. `feedings` and `diaper_changes`
  have no update/delete RLS policy, so a mis-tap at 3am is permanent
  until a `0002` migration adds one — worth doing before real use
- Real visual design (current styling is functional, not designed)
- PWA manifest/service worker for installable offline behavior
- Anything related to calendar, meal planning, chores, irrigation —
  those belong to the Hub, a separate future project, not this repo

---

## Next steps

1. ~~Init git locally~~ — done, `main`, `.gitignore` in place.
2. **Keep building UI locally** against `supabase start`. Nothing in
   the backend change blocks this, and it is the right thing to be
   doing before Amelia arrives.
3. **Do not create a GitHub repo for this directory on its own.** The
   monorepo (ADR 0003) is the Hub agent's phase 0; this directory
   becomes `apps/amelia` inside it. A standalone repo now would just
   have to be unpicked.
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
- Design tokens move to `packages/ui`. The palette is already
  consolidated in `components/ui.tsx` rather than scattered as inline
  hex, so this is a move rather than a rewrite — but per
  `CONVENTIONS.md` §3 the current styling is explicitly *not* the
  pattern to copy.
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
  Not yet implemented; nothing calls the endpoint.
- 2FA on Supabase / Vercel / GitHub accounts, once those exist
