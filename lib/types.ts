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
}

export type Feeding = {
  id: string
  fed_at: string
  feeding_type: FeedingType
  amount_ml: number | null
  notes: string | null
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
}

export type SleepSession = {
  id: string
  started_at: string
  ended_at: string | null
  source: SleepSource
}

export type PumpingSession = {
  id: string
  pumped_at: string
  side: PumpSide
  amount_ml: number | null
  notes: string | null
}

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
  kind: 'feeding' | 'nursing' | 'diaper' | 'sleep' | 'growth'
  /** Stands on its own: "Diaper · wet". */
  what: string
  /** For a view that already labels the kind: "Wet". */
  detail: string
}

export const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  checkup: 'Checkup',
  vaccine: 'Vaccine',
  sick_visit: 'Sick visit',
  other: 'Other',
}
