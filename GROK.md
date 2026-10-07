# GROK.md — Amelia App agent brief

Short role brief for **Grok Bot** (Amelia App agent). Read this at the
start of a session on this repo. **`CLAUDE.md` wins on every conflict** —
this file does not override it. After both, read `PROJECT.md`,
`design.md`, and `docs/checklist-cada-cambio.md` before changing code.

---

## Who owns what

| Area | Owner | Notes |
|---|---|---|
| **Amelia App** (`emireymon09-create/repmonti09`) | This agent | App code, API, migrations when Emilio asks, docs in this repo |
| Wall screen / HA hardware shopping | **Home Lab** agent | Monitor, mount, HA Green, NUC kit — not this repo |
| Buying or contacting sellers | **Emilio only** | Never buy, never email/message a seller without his explicit OK naming what and to whom |

If a task crosses into Home Lab hardware, stop and hand it off. Do not
shop, compare prices into a cart, or open seller chats from this agent.

---

## Display priority (Emilio, 2026-10-06)

Order of surfaces for this household:

1. **Phone** — primary day-to-day use
2. **Changing-table touchscreen** — local device; see `proposals/changer-display.md`
3. **HA 27" wall** — Amelia is **one card/panel** on the Home Assistant
   dashboard, not a dedicated full-screen kiosk

PR #2 (`docs/display-priority`, merged) wrote this into `PROJECT.md` /
`design.md`. Do not push `design.md`'s primary-target wording further
without asking Emilio. `CLAUDE.md` §1 still describes the wall as a design
target for layout scale — that hard rule stands until he says otherwise.

---

## HA wall card architecture

- Home Assistant talks to Amelia over the **LAN** with REST sensors /
  `rest_command` (or equivalent). HA entities hold the numbers.
- The wall **card only renders HA entities**. It must not call Amelia's
  `http://` API from an `https://` HA frontend (mixed content).
- Camera video/images/audio **never** leave the house (`CLAUDE.md` §1).
  Only derived events may hit `/api/ingest`.

---

## Version + CHANGELOG (`CLAUDE.md` §0.1)

Every push that lands on `main` needs:

1. A semver bump in `package.json` (`version`)
2. A matching `## [x.y.z] - YYYY-MM-DD` entry at the top of `CHANGELOG.md`,
   in **English**, in terms of who uses the app

`pnpm test` includes `tests/unit/changelog.test.ts` — it fails if the two
disagree. No exceptions for "docs only" or "tiny fix".

When other open PRs already claimed PATCH numbers, pick the next free one
and note merge order in the PR body (rebase + rebump if merging out of
order).

---

## Milk — v4 (reusable bottles) is released

Released in **0.13.0** (see `CHANGELOG.md`). Current state:

- Pumping logs **left and right** separately (each in oz or ml); the server
  stores the total. Milk goes into a reusable bottle **M1–M6** (count set
  in Settings → Milk storage → Milk bottles, 1–30, default 6). None is
  pre-picked; a bottle still holding milk can't be chosen.
- Milk page lists usable milk per bottle; fridge milk lasts 4 days from
  pumping start (configurable). Expired bottles stop counting; "Discard"
  frees the bottle and adds to the "Discarded milk" total.
- Today suggests each bottle (oldest milk first, topped up with formula);
  optional "Left over" is stats only. Past bottles are editable from
  History / Feeding with a server-side check before saving.
- Schema: `supabase/migrations/0014_milk_inventory.sql` +
  `0015_milk_phase1_2.sql`; logic in `lib/milk.ts`, writes via `lib/db.ts`.
  Detail: `docs/milk-business-logic.md`, `docs/spec-feeding-v4.md`,
  `docs/milk-v4-para-aprobar.md`, rollback `docs/rollback-leche-v4.sql`,
  deploy `docs/runbook-despliegue-v4.md`.
- Before claiming 0014/0015 are applied in the cloud, verify it
  (`docs/verificar-antes-v4.sql`) — older docs disagree on this.

Changes to milk rules still need Emilio's OK; follow `CLAUDE.md`.

---

## Nursery camera

- Camera: **Reolink E1 Zoom** (not Argus 3 Pro)
- Frigate runs on the **NUC** (not HA Green — OpenVINO is Intel-only)
- Detail: `proposals/nursery-camera-integration.md`
- Video stays on-LAN; Amelia only consumes derived events

`PROJECT.md` on `main` has the corrected camera (PRs #1/#2 merged).

---

## How to work

- **Terse and concrete.** Verify against the code before claiming facts
  (`CLAUDE.md` §0).
- **PR for review**, including version bump + CHANGELOG entry.
- **Never merge** unless Emilio explicitly asks to merge that PR.
- Before opening a PR: run at least `pnpm test` and `pnpm format:check`
  (and the broader suite when the change warrants it — see
  `docs/checklist-cada-cambio.md`).
- Prefer English commit subjects in plain language (match recent `main`).
- `pnpm` only — never `npm` / `yarn` (`CLAUDE.md` §5.1).

---

## Hard rules live elsewhere

| File | Role |
|---|---|
| `CLAUDE.md` | Hard rules. Wins every conflict. |
| `PROJECT.md` | Architecture and current state |
| `design.md` | UI/UX tokens, scale, patterns |
| `docs/checklist-cada-cambio.md` | Per-change checklist |
| `docs/README.md` | Index of working docs |
| `proposals/` | Plans not yet approved to build |

If this brief and `CLAUDE.md` disagree, follow `CLAUDE.md` and say so.
