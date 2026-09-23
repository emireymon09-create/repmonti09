# Changelog

Every version of Amelia, newest first. The current version is the `version`
field in `package.json`; this file is the history. A test fails if the two
disagree. Shown in the app under the settings gear → Version history.

## [0.9.0] - 2026-09-23

A Statistics screen joins the bottom bar, "today's" totals become the last
24 hours, amounts are always shown in ounces, and a session that is running
can have its start moved back.

- New Statistics screen, reachable from the bottom bar and from the Menu. It
  has nothing drawn in it yet and says so; the totals stay on each section's
  page until the charts exist.
- The phone's bottom bar is four buttons now — Today, Milk, Stats, Menu —
  and the Menu lists all ten screens in one column.
- The short totals on Feeding, Diapers and Sleep count the **last 24 hours**
  instead of since midnight, and say so. A feed at 11 pm still counts at
  1 am. The 7-day totals and the log below are unchanged: the log is still
  grouped by the day things happened.
- Amounts are shown in ounces everywhere. The oz/ml switch left Settings;
  instead, the bottle field has its own oz/ml toggle for the number you are
  typing right now, and it goes back to ounces after every entry. Nothing
  already logged changes.
- "Reset milk total" is gone from Settings. A reset done earlier still
  applies to the Milk total.
- "Solid" is no longer offered when logging a feeding. Solids already logged
  stay in the log, in History and in the totals, and can still be corrected.
- While a feeding or a sleep is running, you can type how many minutes
  earlier it really started and move the start back — as many times as you
  need. It refuses a start more than 4 hours back at once, or more than
  12 hours back in total, and it says why.
- Moving a start back now checks the session is still running first. If the
  other phone already stopped it, nothing is written and the screen says so
  instead of quietly stretching a finished session.
- Today no longer says "The log starts here" while it is still loading. A
  household with entries never sees that message.
- The oz/ml toggle is now as tall as the field and the button beside it, so
  it can be hit as easily one-handed.
- In Spanish, the bottle row fits on one line on the wall screen again, so
  the three cards on Today stay the same height as in English.
- Fixed: on an iPhone the bottom bar used to come loose while scrolling and
  float over the middle of the list, dropping back to the edge when you let
  go. It now stays at the bottom edge the whole time, and it no longer jumps
  when a screen finishes loading.
- Today shows the age on its own line under the name again, instead of
  beside it.

## [0.8.0] - 2026-09-23

Settings gets its own screen, the Menu becomes a plain list, and the two
screens that start out empty now say what goes in them.

- Everything that used to live inside the Menu's drop-down — the theme, the
  language, the nursing alerts, the oz/ml switch, "Reset milk total" and
  signing out — is now a screen of its own, Settings. Nothing is in both
  places: the Menu is navigation and nothing else.
- The Menu is a single column now, one screen per row with its icon:
  Feeding, Diapers, Sleep, Milk, Growth, Doctor, History, Settings. It used
  to be two columns of eight. The version number sits at the foot of it, and
  tapping it still opens the version history.
- The Menu button in the bottom bar has a new icon: three upright bars. The
  sliders icon it had now marks Settings, which is what it actually means.
- Growth and Doctor no longer leave half the screen blank before anything is
  logged. Each one now centres a short note in that space saying what will
  show up there. With entries logged, the screens are unchanged.
- Moving between screens fades in instead of snapping. On a quick load the
  word "Loading…" no longer flashes at all; on a slow one it fades in too.
  The bottom bar never moves.
- Today's three cards drop the "Totals and log →" line at the bottom. The
  arrow in the corner of each card still opens the same page.
- The preview server now listens only on this machine. It was reachable from
  the network, which it never should have been.

## [0.7.0] - 2026-09-22

The bottom bar on a phone is down to two buttons, Today and Menu, and the
long-nursing alert now has something that actually sets it off.

- The phone's bottom bar has two buttons instead of six: Today, and Menu.
  Menu holds every other screen — Feeding, Diapers, Sleep, Milk, Growth,
  Doctor, History and Version history — plus the theme, the language, the
  nursing alerts and the rest of the settings. Each button is now half the
  width of the screen, so it is hard to miss one-handed in the dark.
  Feeding, Diapers and Sleep had no menu entry at all until now.
- On a tablet or the wall screen the top row of tabs is unchanged.
- Today's three cards line up: each one has a small corner button that opens
  its page, and side by side on the wall they are all the same height.
- Today's heading puts the name and the age on one line, with today's date
  on the right instead of above everything.
- Moving between screens no longer empties the window. The bottom bar used
  to disappear along with the content while the next screen loaded; it now
  stays put.
- Nursing alerts: a subscription the push service keeps turning away is
  dropped after three checks in a row, but only while other devices are
  still getting the notification — if every device is turned away at once,
  nothing is deleted, because that is a server misconfiguration and not a
  dead phone.

## [0.6.0] - 2026-09-22

Today is down to three cards, each with its own page of totals, and this
device can be told when nursing runs long.

- Today now shows three cards — Feeding, Diaper and Sleep — each with the
  last one that was logged and a link to its own page. The list of
  everything logged today, and the next appointment, are no longer on
  Today; the full list still lives on History, and appointments on Doctor.
- New Feeding, Diaper and Sleep pages: how much today and over the last 7
  days — feedings by kind, bottle total, time at the breast, diapers by
  kind, time asleep and naps — with every entry underneath.
- On those pages an entry can be corrected or removed, one at a time, and
  a removed one stops counting toward the totals without disappearing
  from the database.
- "Log a past one" on each page replaces "Log a missed session" on Today,
  and it can also log something that is still running — a nursing session
  or a sleep that started a while ago and hasn't ended. It won't let you
  open a second one while one is already running.
- The totals say so when they include something that hasn't synced yet,
  and show "—" instead of a made-up number when this device has nothing
  saved and no connection.
- The three new pages open without a connection, like the rest.
- New in the settings gear: Nursing alerts. Turned on, this device gets a
  notification when a nursing session has been running for 30 minutes and
  nobody has stopped it — once per session, written in the language this
  device is set to. It says why it can't be turned on where it can't
  (a browser without notifications, an iPhone until Amelia is added to
  the Home Screen, notifications blocked for the site). Signing out turns
  it off on that device. **Not arriving by itself yet:** something has to
  ask the server to check every minute, and that piece isn't set up.
- Next feeding is no longer predicted while a nursing session is running.

## [0.5.0] - 2026-09-22

The app opens without a connection, and syncing no longer gets stuck.

- Entries saved without a connection no longer clash or block syncing when
  they're sent again after reconnecting — with two tabs open, or when the
  answer from the server got lost on the way back.
- A tab stuck on a request no longer holds up the others, and syncing tries
  again by itself, also on bad wifi that the device still calls connected.
- If the server rejects a saved entry, the warning names it and lets you
  discard it, after a confirmation that says exactly what will be lost; the
  entries behind it then sync.
- The Nursing and Sleep cards on Today show "Not synced yet" too.
- A nursing or sleep session that's still running now shows up in Today — at
  the top, even if it started before midnight — and in History.
- On History, an edit made without a connection is marked "Not synced yet"
  right away.
- Opening the app without a connection shows what this device last saw, with a
  note saying from when, or a clear message if nothing is saved yet — instead
  of sending you to the login page.
- After you sign in, the app's pages open without a connection.
- The copy saved on this device is erased when you sign out.

## [0.4.3] - 2026-09-21

History and Today stay put when the connection drops.

- On History and on Today, the list no longer goes blank while you're offline:
  what was last loaded stays on screen, and anything added, corrected or
  deleted without a connection shows "Not synced yet" until it reaches the
  server.
- Today no longer loses the running nursing timer, the last diaper, the last
  sleep or the next appointment while you're offline, so it never offers to
  start a second session while one is still running.
- A nursing or sleep session started without a connection shows as running on
  Today right away, and the buttons are ready for the next tap without waiting.
- History now shows the sync bar, says so if something couldn't sync, and after
  an edit or delete without a connection says it was saved on this device
  instead of just "Saved".
- An entry that finishes syncing while a page is loading is no longer shown
  twice.

## [0.4.2] - 2026-09-21

Easier to read in the dark theme, and Growth is honest about what hasn't synced.

- In the dark theme, the "Stop nursing" button, the breast side next to the
  timer, the weight gain on Growth, past appointments on Doctor and the hint
  text inside fields are easier to read.
- Past appointments are a little less faded in both themes, so their date and
  details stay readable.
- In the light theme, text fields and the Theme and Language switches are back
  to their soft blush color instead of white.
- A measurement added, corrected or deleted on Growth without a connection now
  shows "Not synced yet" until it reaches the server, and the list no longer
  goes blank while you're offline.
- After you cancel or save an edit on Growth, Milk or History, the keyboard
  focus goes back to that entry's Edit button.
- On a tablet or the wall screen, the settings button uses the same icon as the
  phone's bottom bar.
- The appointment type picker on Doctor keeps its full size on an iPhone.
- On an iPhone, the app now keeps its content clear of the notch, the status bar
  and the home indicator.

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
