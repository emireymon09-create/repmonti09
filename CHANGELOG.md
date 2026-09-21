# Changelog

Every version of Amelia, newest first. The current version is the `version`
field in `package.json`; this file is the history. A test fails if the two
disagree. Shown in the app under the settings gear → Version history.

## [0.4.1] - 2026-09-21

Calmer wording in Spanish and a white background in the light theme.

- In Spanish, diapers are now "Mojado", "Sucio" and "Mojado y sucio", in the
  same plain tone as "Wet", "Dirty" and "Both" in English.
- The light theme's page background is white instead of blush. Cards, buttons
  and the rest of the pastel colors are unchanged; text fields and the Theme
  and Language switches in the settings menu are white too, and their hint
  text is easier to read.

## [0.4.0] - 2026-09-21

Amelia speaks Spanish, and date fields stay inside their card on an iPhone.

- The whole app is available in Spanish: sign-in, Today, Milk, Growth, Doctor,
  History, the menus and the sync messages. By default it follows the
  device's language; pick System, English or Español under the settings gear
  to choose for this device.
- Dates and times read the Spanish way in Spanish, on a 24-hour clock. In
  English they stay as before, with small fixes: "1 month old" instead of "1
  months old", and proper apostrophes.
- These release notes stay in English, and so do the technical details some
  error messages carry. The calendar that pops up from a date field follows
  the phone's own language.
- Date and time fields on an iPhone no longer run past the right edge of
  their card (confirmed on a real iPhone).

## [0.3.1] - 2026-09-21

Easier to get around on a phone.

- On a phone, the tabs move to a bar at the bottom of the screen, within reach
  of your thumb, with an icon and a name for each one. All five tabs and the
  settings gear fit on one line; tablets and the wall screen are unchanged.
- History no longer repeats the kind of entry: "Diaper · Wet" instead of
  "Diaper · Diaper · wet", and "Nursing · Left side" instead of "Nursing ·
  Nursed · left".

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
