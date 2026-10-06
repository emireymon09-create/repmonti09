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

Open PR #2 (`docs/display-priority`) writes this into `PROJECT.md` /
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

## Milk work — do not implement schema yet

Luis has a milk rules doc. Emilio's answers are in review with Ana. Until
an **approved** rules proposal lands and Emilio OK's implementing it:

- Do **not** add milk schema / migrations / stash bottle UI as product code
- Answer-sheet and design talk is fine; shipping schema is not

Propose in `proposals/` if useful; wait for the green light to build.

---

## Nursery camera

- Camera: **Reolink E1 Zoom** (not Argus 3 Pro)
- Frigate runs on the **NUC** (not HA Green — OpenVINO is Intel-only)
- Detail: `proposals/nursery-camera-integration.md`
- Video stays on-LAN; Amelia only consumes derived events

`PROJECT.md` on `main` may still say Argus / HA Green until PR #2 merges —
prefer the proposal and Emilio's correction when they disagree.

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
