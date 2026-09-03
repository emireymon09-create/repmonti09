# Amelia App — Local Development First

This gets you a fully working version running on your own machine —
real Postgres database, real auth, real API — with zero cloud
accounts, zero cost, and nothing deployed anywhere yet. Cloud
deployment (Supabase project + Vercel) is a later step, once this is
actually working the way you want.

## Prerequisites

- **Node.js** (LTS) — you already have this from earlier in the project
- **Docker Desktop** — Supabase's local stack runs in Docker
  containers under the hood. Install from docker.com if you don't
  have it, then make sure it's running before the next steps.
- **Supabase CLI** — install with:
  ```bash
  npm install -g supabase
  ```

## 1. Start the local Supabase stack

From the `amelia-app` folder:

```bash
supabase init
```

(This may say a config already exists — that's fine, `supabase/config.toml`
is already included in this project.)

```bash
supabase start
```

First run takes a few minutes (pulls Docker images). When it's done,
it prints a block of URLs and keys — a local Postgres database, a
local Auth server, a local API, and **Supabase Studio** (a local
dashboard UI) at `http://localhost:54323`.

The schema in `supabase/migrations/0001_init.sql` gets applied
automatically on `supabase start`. If you change the schema later and
want to re-apply cleanly:

```bash
supabase db reset
```

## 2. Connect the Next.js app to your local Supabase

```bash
cp .env.local.dev .env.local
npm install
npm run dev
```

Visit `http://localhost:3000/login`.

## 3. Create your account + link it to a baby

1. On `/login`, sign up with any email/password — since this is local,
   there's no real email sending, the account activates immediately
2. Open **Supabase Studio** at `http://localhost:54323` → Table Editor
3. `families` → insert one row (e.g. name: "Reyes Family")
4. **Authentication** tab → copy your new user's UUID
5. `family_members` → insert a row: your `family_id` + your user UUID
6. `babies` → insert Amelia's row with that same `family_id`
7. Refresh `/dashboard` in the app — you should now see her name and
   be able to log a feeding/diaper change

## 4. Iterate

This is now a real, working local app. Test the flows, and tell me
what to build next (sleep session UI, growth tracking, calendar) —
we build and test it all locally first.

## 5. Cloud deployment — later, not now

When you're happy with it locally, deploying to real Supabase +
Vercel is mostly copy-paste: create a real Supabase project, run the
same migration file there instead of locally, swap `.env.local`'s
values for the real project's URL/keys, then deploy to Vercel. Full
steps for that stage will come once we're actually ready for it.

## What's built vs. what's next

**Built:**
- Local Supabase stack (Postgres + Auth + API), schema with RLS
  enabled on every table from the start
- Auth (email/password)
- Dashboard: log feeding (bottle/nursing/solid) and diaper changes,
  shows last-logged time
- `/api/ingest` — the endpoint the NUC will eventually push sleep/
  event data to (device-secret auth, never video) — built but not
  yet called by anything real, since the NUC-side automation doesn't
  exist yet

**Not built yet:**
- Sleep session UI (table + ingest endpoint exist, no dashboard view)
- Growth measurements UI
- Calendar / appointments
- The NUC-side HA automation that would actually call `/api/ingest`
- Retry-queue logic for offline gaps (flagged in the architecture doc)
- PWA manifest/service worker for installable offline behavior
- Real visual design — current styling is a placeholder using the
  earlier kitchen-app color palette
