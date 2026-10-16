#!/usr/bin/env python3
"""
Reolink E1 Zoom / E340 — bassinet tube clamp (CadQuery)

Parametric BREP model. Edit the PARAMS dict, then re-run to regenerate
STEP (+ optional STL). Open the .step files in CATIA / 3DEXPERIENCE /
SolidWorks as solids; change numbers here and re-export for design
changes that should stay parametric.

Units: millimetres.
Tube axis = X. Split on the XZ plane. Camera pad on +Z.
"""

from __future__ import annotations

import json
from pathlib import Path

import cadquery as cq

# ---------------------------------------------------------------------------
# Editable parameters — change these, then:  python3 clamp.py
# ---------------------------------------------------------------------------
PARAMS = {
    # Tube (Emilio caliper: 3/4" = 19.05 mm)
    "tube_od": 19.05,
    "bore_clearance": 0.40,  # diametral, before liner
    "liner_thickness": 0.80,  # 0 to disable liner recess / part
    "clamp_length": 36.0,  # along tube (X)
    "wall": 5.0,  # radial wall around bore
    # M4 clamp screws through the side ears
    "m4_clear": 4.3,
    "m4_head_d": 8.0,
    "m4_head_h": 3.0,
    "m4_nut_af": 7.2,
    "m4_nut_h": 3.4,
    "ear_width": 12.0,
    "ear_stickout": 11.0,
    "screw_span": 22.0,  # M4 centres along X
    "ear_embed": 2.0,  # overlap into the opposite half so solids merge
    # Stock Reolink wall plate on the top pad (MEASURE your plate)
    "plate_hole_spacing": 17.8,
    "plate_slot_extra": 5.0,
    "m3_clear": 3.3,
    "m3_nut_af": 5.7,
    "m3_nut_h": 2.5,
    "pad_thick": 6.0,
    "pad_diameter": 72.0,
    "pad_center_dimple_d": 10.0,
    "pad_center_dimple_h": 0.8,
    # Cable tie on pad rim
    "tie_w": 4.0,
    "tie_h": 2.2,
}

OUT = Path(__file__).resolve().parent / "step"
STL_OUT = Path(__file__).resolve().parent / "stl"


def _derived(p: dict) -> dict:
    bore_r = (
        p["tube_od"] / 2
        + p["bore_clearance"] / 2
        + (p["liner_thickness"] if p["liner_thickness"] > 0 else 0)
    )
    shell_r = bore_r + p["wall"]
    return {**p, "bore_r": bore_r, "shell_r": shell_r}


def _hex_af_to_circumscribed_diameter(af: float) -> float:
    # Across-flats → across-corners for a regular hex (nut trap).
    return af / 0.8660254037844386 + 0.25


def _tube_bore(shell_r: float, clamp_length: float, bore_r: float) -> cq.Workplane:
    return (
        cq.Workplane("YZ")
        .workplane(offset=-clamp_length / 2)
        .circle(bore_r)
        .extrude(clamp_length + 2)
        .translate((0, 0, 0))
    )


def _ear_block(p: dict, is_top: bool) -> cq.Workplane:
    """One pair of M4 ears as a single solid (both X positions)."""
    shell_r = p["shell_r"]
    ear_h = 2 * shell_r
    ear_depth = shell_r + p["ear_stickout"] + p["ear_embed"]
    blocks = []
    for sx in (-p["screw_span"] / 2, p["screw_span"] / 2):
        if is_top:
            # y from -ear_embed to shell_r+ear_stickout
            y0 = -p["ear_embed"]
        else:
            # y from -(shell_r+ear_stickout) to +ear_embed
            y0 = -(shell_r + p["ear_stickout"])
        block = (
            cq.Workplane("XY")
            .transformed(offset=(sx, y0 + ear_depth / 2, 0))
            .box(p["ear_width"], ear_depth, ear_h)
        )
        blocks.append(block)
    return blocks[0].union(blocks[1])


def _half_shell(p: dict, is_top: bool) -> cq.Workplane:
    shell_r = p["shell_r"]
    clamp_length = p["clamp_length"]

    # Full cylinder along X, then keep y>=0 (top) or y<=0 (bottom).
    cyl = (
        cq.Workplane("YZ")
        .circle(shell_r)
        .extrude(clamp_length)
        .translate((-clamp_length / 2, 0, 0))
    )
    # Cutting box for the unused half (leave a little past centreline)
    cut_size = max(shell_r, p["ear_stickout"]) * 4 + 20
    if is_top:
        # remove y < 0
        cutter = (
            cq.Workplane("XY")
            .transformed(offset=(0, -cut_size / 2, 0))
            .box(clamp_length + 4, cut_size, cut_size)
        )
    else:
        cutter = (
            cq.Workplane("XY")
            .transformed(offset=(0, cut_size / 2, 0))
            .box(clamp_length + 4, cut_size, cut_size)
        )
    shell = cyl.cut(cutter)
    shell = shell.union(_ear_block(p, is_top))

    if is_top:
        # Neck overlapping the shell, then the camera pad disc
        neck = (
            cq.Workplane("XY")
            .transformed(offset=(0, 0, shell_r - 2))
            .box(36, 16, 4 + p["pad_thick"])
        )
        pad = (
            cq.Workplane("XY")
            .workplane(offset=shell_r)
            .circle(p["pad_diameter"] / 2)
            .extrude(p["pad_thick"])
        )
        shell = shell.union(neck).union(pad)

    # Tube bore
    bore = (
        cq.Workplane("YZ")
        .circle(p["bore_r"])
        .extrude(clamp_length + 4)
        .translate((-clamp_length / 2 - 2, 0, 0))
    )
    shell = shell.cut(bore)

    # M4 holes + head/nut recesses
    for sx in (-p["screw_span"] / 2, p["screw_span"] / 2):
        y_outer = (
            shell_r + p["ear_stickout"] / 2
            if is_top
            else -(shell_r + p["ear_stickout"] / 2)
        )
        hole = (
            cq.Workplane("XY")
            .transformed(offset=(sx, y_outer, 0))
            .circle(p["m4_clear"] / 2)
            .extrude(2 * shell_r + 4, both=True)
        )
        shell = shell.cut(hole)
        if is_top:
            head = (
                cq.Workplane("XY")
                .workplane(offset=shell_r - p["m4_head_h"])
                .center(sx, y_outer)
                .circle(p["m4_head_d"] / 2)
                .extrude(p["m4_head_h"] + 0.2)
            )
            shell = shell.cut(head)
        else:
            nut_d = _hex_af_to_circumscribed_diameter(p["m4_nut_af"])
            nut = (
                cq.Workplane("XY")
                .workplane(offset=-shell_r)
                .center(sx, y_outer)
                .polygon(6, nut_d)
                .extrude(p["m4_nut_h"] + 0.2)
            )
            shell = shell.cut(nut)

    if is_top:
        # Slotted M3 for stock Reolink plate (slots along Y)
        slot_half = p["plate_slot_extra"]
        for sgn in (-1, 1):
            cx = sgn * p["plate_hole_spacing"] / 2
            # Slot = hull of two circles — approximate with a slot sketch
            slot = (
                cq.Workplane("XY")
                .workplane(offset=shell_r - 0.1)
                .center(cx, 0)
                .slot2D(2 * slot_half + p["m3_clear"], p["m3_clear"], 90)
                .extrude(p["pad_thick"] + 0.4)
            )
            shell = shell.cut(slot)
            # M3 nut trap under the pad (hex, same slot footprint via deep hex at each end + middle)
            nut_d = _hex_af_to_circumscribed_diameter(p["m3_nut_af"])
            for dy in (-slot_half, 0, slot_half):
                nut = (
                    cq.Workplane("XY")
                    .workplane(offset=shell_r - 0.1)
                    .center(cx, dy)
                    .polygon(6, nut_d)
                    .extrude(p["m3_nut_h"] + 0.2)
                )
                shell = shell.cut(nut)

        # Centre dimple (must stay inside the M3 slots)
        dimple = (
            cq.Workplane("XY")
            .workplane(offset=shell_r + p["pad_thick"] - p["pad_center_dimple_h"])
            .circle(p["pad_center_dimple_d"] / 2)
            .extrude(p["pad_center_dimple_h"] + 0.2)
        )
        shell = shell.cut(dimple)

        # Cable-tie slot on pad rim
        tie = (
            cq.Workplane("XY")
            .workplane(offset=shell_r + p["pad_thick"] - p["tie_h"])
            .center(0, p["pad_diameter"] / 2 - 2)
            .box(p["tie_w"], 8, p["tie_h"] + 0.2, centered=(True, True, False))
        )
        shell = shell.cut(tie)

    return shell


def tpu_liner(p: dict) -> cq.Workplane:
    if p["liner_thickness"] <= 0:
        raise ValueError("liner_thickness must be > 0 to build the liner")
    h = p["clamp_length"] - 1
    inner = p["tube_od"] / 2
    outer = p["tube_od"] / 2 + p["liner_thickness"]
    tube = (
        cq.Workplane("YZ")
        .circle(outer)
        .circle(inner)
        .extrude(h)
        .translate((-h / 2, 0, 0))
    )
    # Lengthwise split so it wraps onto the tube
    slit = (
        cq.Workplane("XY")
        .box(h + 2, 0.7, outer * 2 + 2)
    )
    return tube.cut(slit)


def export_step(workplane: cq.Workplane, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cq.exporters.export(workplane, str(path), exportType="STEP")
    print(f"wrote {path}")


def export_stl(workplane: cq.Workplane, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cq.exporters.export(workplane, str(path), exportType="STL")
    print(f"wrote {path}")


def main() -> None:
    p = _derived(PARAMS)
    OUT.mkdir(parents=True, exist_ok=True)

    # Keep a machine-readable copy of the knobs next to the STEP files
    # so CATIA/3DX sessions can see what was used without opening Python.
    (OUT / "params.json").write_text(json.dumps(p, indent=2) + "\n")
    print(f"wrote {OUT / 'params.json'}")

    top = _half_shell(p, is_top=True)
    bottom = _half_shell(p, is_top=False)

    export_step(top, OUT / "top_half.step")
    export_step(bottom, OUT / "bottom_half.step")

    # Assembly compound for context in 3DX (still separate solids)
    assembly = top.union(bottom)
    export_step(assembly, OUT / "assembly.step")

    if p["liner_thickness"] > 0:
        liner = tpu_liner(p)
        export_step(liner, OUT / "tpu_liner.step")
        export_stl(liner, STL_OUT / "tpu_liner.stl")

    # Keep STLs in sync for Bambu
    export_stl(top, STL_OUT / "top_half.stl")
    export_stl(bottom, STL_OUT / "bottom_half.stl")

    print("done")


if __name__ == "__main__":
    main()
