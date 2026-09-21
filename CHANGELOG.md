# Changelog

Every version of Amelia, newest first. The current version is the `version`
field in `package.json`; this file is the history. A test fails if the two
disagree. Shown in the app under the settings gear → Version history.

## [0.3.0] - 2026-09-21

A light, pastel theme, and a tidier app on both the phone and the wall screen.

- A light theme in soft pastels, alongside the dark one. Pick Light, Dark or
  System under the settings gear; each device remembers its own choice.
- Only one entry can be edited at a time, so a second form or a delete
  confirmation never opens on top of unsaved changes.
- The settings menu closes when you tap anywhere else or press Escape.
- Even spacing across screens: the Doctor headings, the "Log a missed
  session" button and the History times no longer crowd what is next to them.
- Edit and Delete are easier to hit with a thumb.

## [0.2.0] - 2026-09-21

Devices get their own keys, growth entries can be fixed, and the development
database stops answering on the internet.

- Each device — the nursery computer, a phone Shortcut — now has its own key,
  tied to one family and revocable on its own. The shared device passwords are
  gone.
- Sleep events and the quick nursing toggle can only land on a baby of the
  family the device belongs to.
- A growth measurement can be edited or deleted from the Growth page. Editing
  the notes no longer nudges the weight by rounding.
- Version history, here, under the settings gear.
- The local development database only listens on this machine.

## [0.1.0] - 2026-09-20

The first version that tracks a baby end to end.

- Nursing, bottle, solids, diapers and sleep from the dashboard, with the next
  feeding and nap predicted.
- Milk pumping, growth, doctor appointments, and a full history with edit and
  delete.
- Installs as an app and keeps working on bad wifi: entries wait on the device
  and sync when it's back, marked "not synced yet" until then.
- Two parents, each with their own login; one family never sees another's data.
