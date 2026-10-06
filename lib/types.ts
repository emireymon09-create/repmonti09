/**
 * Row types for the tables this app reads.
 *
 * CONVENTIONS.md §2: "Types come from `packages/db/types` (generated).
 * Do not hand-write a row type — a column rename should break the build."
 * That package does not exist yet, so this file is the stand-in and the
 * single place these shapes are written down. When the monorepo lands,
 * delete this file and re-point the imports at the generated types; the
 * names below deliberately match the column names so that is a swap.
 */

export type FeedingType = 'bottle' | 'nursing' | 'solid'
export type DiaperType = 'wet' | 'dirty' | 'both'
export type Side = 'left' | 'right'
export type SleepSource = 'manual' | 'nuc_derived'
export type PumpSide = 'left' | 'right' | 'both'
export type AppointmentType = 'checkup' | 'vaccine' | 'sick_visit' | 'other'

/** Display/entry unit for milk amounts. Stored as ml either way. */
export type VolumeUnit = 'oz' | 'ml'

export type Baby = {
  id: string
  name: string
  birth_date: string | null
  pumping_reset_at: string | null
  /**
   * La familia a la que pertenece. La leen los ajustes compartidos (0012:
   * `family_settings` y `calendar_feeds`), que tienen scope por `family_id`
   * DIRECTO y no por un join a través de `baby_id` — la forma de la fase 2.
   */
  family_id: string
}

export type Feeding = {
  id: string
  fed_at: string
  feeding_type: FeedingType
  amount_ml: number | null
  notes: string | null
  /**
   * The breakdown of a bottle logged through the milk inventory (0014):
   * breast milk served from containers, and formula on top. Both null on a
   * feeding logged before that — the "legacy" rows, still fully editable.
   * Written by the server (log_bottle_feed), never typed by a page.
   */
  breast_milk_ml?: number | null
  formula_ml?: number | null
  /**
   * "Sobró X oz" (0015, D-10): what the baby left in the bottle. Statistics
   * only — it never gives milk back to a container and never counts as
   * discarded milk. Null = not known / nothing left. At most `amount_ml`.
   */
  leftover_ml?: number | null
}

export type DiaperChange = {
  id: string
  changed_at: string
  diaper_type: DiaperType
}

export type NursingSession = {
  id: string
  side: Side
  started_at: string
  ended_at: string | null
  /**
   * When the "nursing is running long" push went out (0009). Only the server
   * check (lib/push/server.ts) reads or writes it; the pages don't select it.
   */
  long_alert_sent_at?: string | null
}

export type SleepSession = {
  id: string
  started_at: string
  ended_at: string | null
  source: SleepSource
}

/**
 * The little that a screen needs to know before it writes over a session it
 * rendered a while ago: is this still the row I think it is, and is it still
 * running? Common to nursing and sleep (`sessionById` in lib/db.ts).
 */
export type RunningSession = {
  id: string
  started_at: string
  ended_at: string | null
}

export type PumpingSession = {
  id: string
  pumped_at: string
  side: PumpSide
  /** The total, written by the server as left + right (0014). */
  amount_ml: number | null
  notes: string | null
  /** Each breast on its own (0014). Null on sessions logged before that. */
  left_ml?: number | null
  right_ml?: number | null
}

/** Where a container of expressed milk is kept. Only the fridge is used today. */
export type MilkLocation = 'fridge' | 'freezer'

/**
 * One physical container of expressed milk (0014): the bottle with "M7" on
 * its tape. Created by the server together with the pumping session that
 * filled it; `remaining_ml` goes down as bottles are served from it.
 */
export type MilkContainer = {
  id: string
  source_session_id: string | null
  label: string
  amount_ml: number
  remaining_ml: number
  stored_at: string
  location: MilkLocation
  expires_at: string
  voided_at?: string | null
  /**
   * When it stopped holding its number (0015): emptied by bottles, or
   * discarded. Null = occupied (if not voided). Set by the server; the
   * offline view sets it too while the write is queued.
   */
  released_at?: string | null
  /**
   * Milk that came back from a bottle (voided or edited down) or from a
   * pumping session edited up, and could not go back in: the container was
   * discarded, voided, or its number already held by another one (D-9, AJ-4).
   * amount = served + discarded + lost + remaining (docs/arquitectura-v4.md §2.1).
   */
  lost_ml?: number
}

/**
 * Expired milk thrown away with "Desechar" (0015, `milk_discards`): ALL that
 * was left in one container (D-5). Not editable or undoable in v4 (D-11).
 * `label` is the container's, read along with it for display.
 */
export type MilkDiscard = {
  id: string
  container_id: string
  amount_ml: number
  discarded_at: string
  reason: 'expired'
  label?: string | null
  voided_at?: string | null
}

/**
 * One portion of a bottle: how much of one container went into one feeding
 * (0014). `label` is the container's, read along with it for display.
 */
export type MilkDrawdown = {
  id: string
  feeding_id: string
  container_id: string
  amount_ml: number
  label?: string | null
  voided_at?: string | null
}

/** The pediatrician's storage rules, one set per family (0014, on `babies`). */
export type MilkRules = {
  milk_room_hours: number
  milk_fridge_days: number
  milk_freezer_months: number
}

/** The rules plus how many physical bottles (M1…MN) there are (0015, D-23). */
export type MilkSettings = MilkRules & { milk_bottle_count: number }

export type GrowthMeasurement = {
  id: string
  measured_at: string
  weight_kg: number | null
  height_cm: number | null
  notes: string | null
}

export type DoctorAppointment = {
  id: string
  title: string
  appointment_type: AppointmentType | null
  scheduled_at: string
  doctor_name: string | null
  notes: string | null
  completed: boolean
}

/**
 * One device's push subscription (0009). Only the server reads these
 * (lib/push/server.ts); RLS shows each parent only their own.
 */
export type PushSubscriptionRow = {
  id: string
  family_id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  lang: 'en' | 'es'
  created_at: string
  updated_at: string
}

/**
 * Uniform result so every caller surfaces failures the same way.
 * `queued` means the write is on this device and not yet on the server —
 * never report it as saved.
 */
export type Result<T> = { data: T; error: string | null; queued?: boolean }

/** A row that exists only in the offline queue so far. */
export type WithPending<T> = T & { pending?: boolean }

/**
 * One entry in the day's timeline.
 *
 * Merged client-side from this app's own tables today. ARCHITECTURE.md
 * §2 puts a `core.activity` append-only feed in the shared backend for
 * exactly this — the wall screen's today panel reading one table
 * instead of eight. When that exists, this type stays and only the
 * source changes.
 */
export type ActivityEntry = {
  id: string
  at: string
  // 'discard' (0015): milk thrown out, never editable. app/history/page.tsx
  // builds an i18n key from this union — `history.kind.discard` exists.
  kind: 'feeding' | 'nursing' | 'diaper' | 'sleep' | 'pumping' | 'growth' | 'discard'
  /** Stands on its own: "Diaper · wet". */
  what: string
  /** For a view that already labels the kind: "Wet". */
  detail: string
  /** A nursing or sleep session still running: `at` is when it started. */
  ongoing?: boolean
}

// Appointment type names live in the dictionaries (lib/i18n, `apptType.*`).
