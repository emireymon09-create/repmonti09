# Bassinet mount — Reolink E1 Zoom (E340)

Two-piece clamp for Amelia’s bassinet rail. Holds the **stock Reolink wall
plate** so the camera twist-locks as designed. Power is the stock **5V barrel
wall adapter** (no UPS) — unplug, move rooms, plug back in.

## What you print

| File | Material | Notes |
|---|---|---|
| `stl/top_half.stl` | PETG (or PLA indoors) | Camera pad + upper clamp |
| `stl/bottom_half.stl` | same | Lower clamp |
| `stl/tpu_liner.stl` | TPU 95A (optional) | Stops spin on the tube |

Source of truth: `clamp.scad` (OpenSCAD Customizer parameters at the top).
Open the STLs in Bambu Studio / OpenSCAD to inspect before printing.

## Hardware (BOM)

- **2× M4×25** (or M4×30) socket-head screws + **2× M4 hex nuts** — clamp the tube
- **2× M3×10** screws + **2× M3 hex nuts** — bolt the stock Reolink plate to the pad
- Stock **Reolink mounting plate** from the camera box
- 2–3 zip ties for the power cable along the **outside** of the frame

## Before you print — measure the plate

1. Take the stock wall plate from the camera box.
2. Measure **centre-to-centre** of its two screw holes with calipers.
3. Open `clamp.scad`, set `plate_hole_spacing` to that number (default `17.8`).
4. Re-export `top_half` (see below). The slots already forgive about ±5 mm.

Tube bore defaults to your measured **¾″ / 19.05 mm** (`tube_od`). If the
clamp is tight or loose, change `bore_clearance` (default `0.40`) or use the
TPU liner.

## Export STLs from OpenSCAD

```bash
openscad -o stl/top_half.stl    -D 'part="top_half"'    clamp.scad
openscad -o stl/bottom_half.stl -D 'part="bottom_half"' clamp.scad
openscad -o stl/tpu_liner.stl   -D 'part="tpu_liner"'   clamp.scad
```

Or: Customizer → set `part` → F6 → File → Export → STL.

## Print settings (Bambu)

- **PETG**, 0.2 mm layer, **≥40%** infill, **4** walls
- Orient: flat pad of `top_half` on the bed (camera face down), ears up
- `bottom_half`: split face on the bed
- TPU liner: as oriented in the STL, 0% infill / 2–3 walls is enough

## Assembly

1. (Optional) Snap the TPU liner onto the **¾″ tube** outside the sleep area.
2. Place top + bottom halves around the tube; install M4 screws/nuts. Snug —
   do not crush the tube.
3. Drop M3 nuts into the traps under the pad. Bolt the **stock Reolink plate**
   onto the pad with M3 screws.
4. Twist the camera onto the plate until it locks.
5. Zip-tie the barrel cable down the **outside** of the frame to the floor /
   wall adapter. Nothing dangling into the bassinet.
6. If the image is upside down: Reolink app → Device Settings → Display →
   rotate / flip.

## Safety

- Camera, clamp, and cable stay **outside** the sleep surface and out of reach.
- Do not mount over the baby’s head on a loose arm.
- Recheck M4 tightness after the first day of moves.

## Out of scope (already decided)

- No portable UPS — plug/unplug between rooms is fine.
- Frigate / go2rtc / HA automations are separate (see
  `proposals/nursery-camera-integration.md`).
