/**
 * How long a page's confirmation banner stays up. "Saved" / "Deleted" keep the
 * short flash they always had; a sentence the person has to READ — milk that
 * didn't go back to its bottle (D-9), said together with "Saved" — stays long
 * enough to read it (QA H5: 2.5 s for 16 words was measured too short).
 * Pure: no clock, no DOM.
 */
export const FLASH_MIN_MS = 2500

/** About 400 ms a word plus a beat to notice it, never under the minimum. */
export function flashMs(message: string): number {
  const words = message.trim().split(/\s+/).filter(Boolean).length
  return Math.max(FLASH_MIN_MS, 1500 + words * 400)
}
