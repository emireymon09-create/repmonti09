# Bassinet mount — Reolink E1 Zoom (E340)

Two-piece clamp for Amelia’s bassinet rail. Holds the **stock Reolink wall
plate** so the camera twist-locks as designed. Power is the stock **5V barrel
wall adapter** (no UPS) — unplug, move rooms, plug back in.

## Files

| Path | What |
|---|---|
| `clamp.py` | **Parametric source** (CadQuery). Edit `PARAMS`, re-run. |
| `step/*.step` | BREP solids for **CATIA / 3DEXPERIENCE / SolidWorks** |
| `step/params.json` | Every dimension used for the last export |
| `stl/*.stl` | Mesh for Bambu (regenerated from the same script) |
| `clamp.scad` | Older OpenSCAD twin (mesh only — prefer `clamp.py`) |

## Open / edit in CATIA or 3DEXPERIENCE

1. Import `step/top_half.step` and `step/bottom_half.step` (or `assembly.step`).
2. You get a clean **MANIFOLD_SOLID_BREP** — real faces/edges, not an STL
   tessellation. Use Direct Edit / modify solid tools as needed.
3. **Feature tree:** STEP does **not** carry CadQuery history into CATIA.
   The editable feature list lives in `clamp.py` → `PARAMS`. Change a number
   there, re-export, re-import (or keep CATIA direct edits on a frozen solid).
4. Use `step/params.json` as the dimension table if you rebuild the part
   natively in Part Design.

```bash
# after editing PARAMS in clamp.py
python3 clamp.py
```

Needs: `pip install cadquery` (once per machine).

### Parameters you will actually touch

| Key | Default | Meaning |
|---|---|---|
| `tube_od` | `19.05` | Measured ¾″ rail |
| `bore_clearance` | `0.40` | Loosen/tighten fit |
| `liner_thickness` | `0.80` | TPU sleeve; `0` disables |
| `plate_hole_spacing` | `17.8` | **Measure your stock plate** (centre–centre) |
| `plate_slot_extra` | `5.0` | Slot forgiveness each side (± mm) |
| `pad_diameter` | `72` | Stock plate footprint |

## Hardware (BOM)

- **2× M4×25** (or M4×30) socket-head + **2× M4 hex nuts** — clamp the tube
- **2× M3×10** + **2× M3 hex nuts** — bolt the stock Reolink plate to the pad
- Stock **Reolink mounting plate** from the camera box
- Zip ties for the power cable on the **outside** of the frame

## Before you print / freeze the STEP

1. Measure the stock plate’s two screw-hole centres.
2. Set `plate_hole_spacing` in `clamp.py`.
3. Run `python3 clamp.py`.
4. Open the new `.step` in 3DX and confirm hole alignment on the real plate.

## Print settings (Bambu)

- **PETG**, 0.2 mm layer, **≥40%** infill, **4** walls
- `top_half`: pad flat on the bed
- `bottom_half`: split face on the bed
- TPU liner optional, 95A

## Assembly

1. (Optional) Snap TPU liner onto the **¾″ tube** outside the sleep area.
2. Clamp top + bottom with M4; snug, don’t crush the tube.
3. M3 nuts in the pad traps → bolt stock Reolink plate → twist camera on.
4. Zip-tie barrel cable down the outside of the frame.
5. If upside down: Reolink app → Display → rotate / flip.

## Safety

Camera, clamp, and cable stay **outside** the sleep surface and out of reach.

## Out of scope

Frigate / go2rtc / HA — see `proposals/nursery-camera-integration.md`.
