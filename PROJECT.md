# Amelia App — Project Handoff

**This is the first deployed piece of a larger "Family Hub" ecosystem.**
It is a standalone app, in its own repo, its own Supabase project, its
own Vercel deploy — not a module inside something bigger. Read this
before touching the repo.

---

## Where this fits in the bigger picture

Emilio is building a self-hosted home system with several pieces.
This app — **Amelia** — is the first one being built and deployed.

```
┌─────────────────────────────────────────────────────┐
│  THE HUB (not started yet)                            │
│  Lives on a 27" touchscreen (living room HMI)          │
│  Will eventually hold: shared calendar, meal plan/     │
│  pantry, grocery list, chores, irrigation control,     │
│  and whatever else gets built later                    │
│  Separate Supabase project + separate Vercel deploy     │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  AMELIA APP (this repo — building now)                 │
│  Baby tracking only: feedings, diaper changes,          │
│  breastfeeding, sleep, growth, doctor appointments      │
│  Own Supabase project + own Vercel deploy               │
└─────────────────────────────────────────────────────┘
           ▲
           │ HTTPS, derived data only, NEVER video
┌─────────────────────────────────────────────────────┐
│  NUC (local, at home)                                  │
│  HAOS + Home Assistant + Frigate (OpenVINO detector)    │
│  Reolink Argus 3 Pro camera — RTSP local only,          │
│  P2P/cloud disabled on the camera itself                │
└─────────────────────────────────────────────────────┘
```

**Hard rule carried through the whole project:** camera video never
leaves the NUC. Only derived events (sleep start/end, sound alerts)
get pushed to this app's `/api/ingest` endpoint.

**Doctor appointments** are logged in this app as a simple input.
Syncing them out to a real shared calendar (CalDAV → iCloud) is
NOT this app's job — that sync logic belongs to the Hub, later. This
app just stores the appointment and exposes a `caldav_uid` column for
whenever that sync gets built.

---

## Current status (as of right now)

- **No git repo yet.** This is a local folder only.
- **No GitHub repo yet.**
- **No cloud Supabase project yet.** Only running locally via
  `supabase start` (Docker).
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

**Dashboard (`/dashboard`):** log feeding, breastfeeding (left/right),
diaper changes, doctor appointments — shows last-logged time for each

**`/api/ingest`:** the one endpoint the NUC will call to push sleep
sessions and monitor events. Authenticates with a shared device
secret (`NUC_DEVICE_SECRET`), NOT a user login, NOT the Supabase
service_role key directly. This endpoint is built but nothing on the
NUC side calls it yet — that HA automation doesn't exist yet.

**`preview.html`:** a standalone, no-setup-needed visual preview of
the dashboard UI (uses temporary browser storage, not the real
database) — useful for quickly showing the design, not for real use.

## What's NOT built yet

- Sleep session UI (table + ingest endpoint exist, no dashboard view)
- Growth measurements UI (table exists, no page)
- The actual NUC-side HA automation that calls `/api/ingest`
- Retry-queue logic on the HA side for when the NUC has no internet
  (data still logs fine locally in HA either way — this is only about
  keeping the cloud copy in sync once connectivity returns)
- Real visual design (current styling is a placeholder)
- PWA manifest/service worker for installable offline behavior
- Anything related to calendar, meal planning, chores, irrigation —
  those belong to the Hub, a separate future project, not this repo

---

## Next steps to actually start the repo

1. **Init git locally:**
   ```bash
   cd amelia-app
   git init
   git add .
   git commit -m "Initial scaffold: schema, auth, dashboard, ingest endpoint"
   ```
   Add a `.gitignore` first (node_modules, .env.local, .next) —
   not currently in this scaffold, create one before the first commit.

2. **Create the GitHub repo**, push this up.

3. **Keep developing locally** against the local Supabase stack
   (`supabase start`) until the app does what's needed.

4. **Cloud deploy, when ready** (not yet): create a real Supabase
   project, run the same migration there, create a Vercel project
   from the GitHub repo, set the four env vars in Vercel's dashboard,
   deploy.

## Security posture (carry forward into the new repo)

- RLS on every table, no exceptions, from the first migration
- `service_role` key only ever touched server-side
  (`lib/supabaseAdmin.ts`, `/api/ingest`) — never imported into a
  `'use client'` file
- NUC authenticates to `/api/ingest` via its own device secret, never
  a real user login
- 2FA on Supabase account + Vercel account + GitHub account, once
  those exist
