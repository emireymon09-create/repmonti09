'use client'

import { useCallback, useEffect, useState } from 'react'
import type { VolumeUnit } from '@/lib/types'

const KEY = 'amelia:volume-unit'
const DEFAULT_UNIT: VolumeUnit = 'oz'

/**
 * Which unit bottle/pump amounts are entered and shown in. A
 * per-device display preference, not app data — nothing here changes
 * what's stored (always ml) or what anyone else on the family sees,
 * so it lives in localStorage instead of the database.
 *
 * Defaults to ounces and stays there during the server render and the
 * client's first paint, since localStorage isn't reachable until
 * after mount; a saved "ml" preference takes effect a moment later.
 */
export function useVolumeUnit(): [VolumeUnit, (unit: VolumeUnit) => void] {
  const [unit, setUnitState] = useState<VolumeUnit>(DEFAULT_UNIT)

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY)
      if (saved === 'oz' || saved === 'ml') setUnitState(saved)
    } catch {
      // Storage unavailable (private mode, etc.) — stay on the default.
    }
  }, [])

  const setUnit = useCallback((next: VolumeUnit) => {
    setUnitState(next)
    try {
      window.localStorage.setItem(KEY, next)
    } catch {
      // Best-effort; this tab's state still updates either way.
    }
  }, [])

  return [unit, setUnit]
}
