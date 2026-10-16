// Reolink E1 Zoom / E340 — bassinet tube clamp
// ============================================================
 // Two-piece clamp for a 3/4" (19.05 mm) round metal tube.
 // Bolts the stock Reolink wall plate on TOP so the camera
 // twist-locks the normal way. Power stays on the wall adapter.
 //
 // Print: top_half, bottom_half, optional tpu_liner.
 // OpenSCAD → F6 → Export STL. Bambu: PETG (or PLA indoors).
 //
 // BEFORE FIRST PRINT: measure the stock plate's two screw-hole
 // centres (calipers) and set plate_hole_spacing. Default 17.8 mm
 // is a community report — slots forgive ±5 mm.

/* [Which part] */
part = "assembly"; // ["assembly", "top_half", "bottom_half", "tpu_liner"]

/* [Tube] */
tube_od         = 19.05; // measured 3/4"
bore_clearance  = 0.40;  // diametral, no liner
liner_thickness = 0.80;  // 0 = no liner recess
clamp_length    = 36;    // along the tube (X); keep > screw_span + ear_width
wall            = 5.0;   // radial wall thickness around the bore

/* [Clamp screws — vertical M4 through the side ears] */
m4_clear      = 4.3;
m4_head_d     = 8.0;
m4_head_h     = 3.0;
m4_nut_af     = 7.2;
m4_nut_h      = 3.4;
ear_width     = 12;
ear_stickout  = 11;      // past the outer shell
screw_span    = 22;      // M4 centres along X (must fit inside clamp_length)

/* [Reolink stock plate on the top half] */
plate_hole_spacing = 17.8; // MEASURE — hole centre distance
plate_slot_extra   = 5.0;  // each side of spacing
m3_clear           = 3.3;
m3_nut_af          = 5.7;
m3_nut_h           = 2.5;
pad_thick          = 6.0;
pad_diameter       = 72;

/* [Cable tie] */
tie_w = 4.0;
tie_h = 2.2;

$fn = 72;
eps = 0.08;

bore_r = tube_od / 2 + bore_clearance / 2
       + (liner_thickness > 0 ? liner_thickness : 0);
shell_r = bore_r + wall;

module hex_trap(af, h) {
  cylinder(h = h + eps, d = af / cos(30) + 0.25, $fn = 6);
}

module ear_blank() {
  // One side ear, local coords: sits at +Y of the shell.
  translate([0, shell_r, 0])
    cube([ear_width, ear_stickout, shell_r * 2], center = false);
}

module clamp_shell_half(is_top) {
  // Tube along X. Split on the XZ plane (y = 0).
  // Top half is y >= 0; bottom half is y <= 0.
  difference() {
    union() {
      // Outer shell (full cylinder, then keep half)
      intersection() {
        rotate([0, 90, 0])
          cylinder(h = clamp_length, r = shell_r, center = true);
        translate([
          -clamp_length / 2 - eps,
          is_top ? 0 : -(shell_r + ear_stickout + 1),
          -(shell_r + 1)
        ])
          cube([
            clamp_length + 2 * eps,
            shell_r + ear_stickout + 2,
            2 * shell_r + 2
          ]);
      }

      // Two ears for M4. Overlap the shell by `ear_embed` so CGAL
      // merges them (a face-only touch becomes Volumes: 2).
      ear_embed = 2.0;
      for (sx = [-screw_span / 2, screw_span / 2]) {
        translate([sx - ear_width / 2, 0, -shell_r]) {
          if (is_top)
            translate([0, -ear_embed, 0])
              cube([ear_width, shell_r + ear_stickout + ear_embed, 2 * shell_r]);
          else
            translate([0, -(shell_r + ear_stickout), 0])
              cube([ear_width, shell_r + ear_stickout + ear_embed, 2 * shell_r]);
        }
      }

      // Camera pad on +Z. A deep rectangular neck overlaps the
      // shell so the pad is not a tangent-only contact.
      if (is_top) {
        translate([-18, -8, shell_r - 4])
          cube([36, 16, 4 + pad_thick]);
        translate([0, 0, shell_r])
          cylinder(h = pad_thick, d = pad_diameter);
      }
    }

    // Tube bore
    rotate([0, 90, 0])
      cylinder(h = clamp_length + 2, r = bore_r, center = true);

    // M4 holes (vertical, through both ears) + head/nut recesses
    for (sx = [-screw_span / 2, screw_span / 2]) {
      y_outer = is_top ? (shell_r + ear_stickout / 2) : -(shell_r + ear_stickout / 2);
      // Through hole
      translate([sx, y_outer, 0])
        cylinder(h = 2 * shell_r + 2, d = m4_clear, center = true);

      if (is_top) {
        // Screw-head pocket from +Z
        translate([sx, y_outer, shell_r - m4_head_h])
          cylinder(h = m4_head_h + eps, d = m4_head_d);
      } else {
        // Nut trap from -Z
        translate([sx, y_outer, -shell_r - eps])
          hex_trap(m4_nut_af, m4_nut_h);
      }
    }

    if (is_top) {
      // Slotted M3 for the stock Reolink plate (along Y on the pad)
      for (sgn = [-1, 1]) {
        hull() {
          for (dy = [-plate_slot_extra, plate_slot_extra]) {
            translate([
              sgn * plate_hole_spacing / 2,
              dy,
              shell_r - eps
            ])
              cylinder(h = pad_thick + 2 * eps, d = m3_clear);
          }
        }
        // M3 nut traps from below the pad (accessible before
        // the camera is twisted on — nuts face the shell)
        hull() {
          for (dy = [-plate_slot_extra, plate_slot_extra]) {
            translate([
              sgn * plate_hole_spacing / 2,
              dy,
              shell_r - eps
            ])
              hex_trap(m3_nut_af, m3_nut_h);
          }
        }
      }

      // Shallow centre dimple only — must stay inside the M3 slots
      // (slots are ~±plate_hole_spacing/2 from centre).
      translate([0, 0, shell_r + pad_thick - 0.8])
        cylinder(h = 1.0, d = 10);

      // Cable-tie slot on the pad rim (route cord down the frame,
      // outside the sleep area).
      translate([-tie_w / 2, pad_diameter / 2 - 6, shell_r + pad_thick - tie_h])
        cube([tie_w, 8, tie_h + eps]);
    }
  }
}

module tpu_liner() {
  h = clamp_length - 1;
  inner = tube_od / 2;
  outer = tube_od / 2 + liner_thickness;
  difference() {
    rotate([0, 90, 0])
      cylinder(h = h, r = outer, center = true);
    rotate([0, 90, 0])
      cylinder(h = h + 2, r = inner, center = true);
    // Lengthwise split
    translate([-h / 2 - 1, -0.35, 0])
      cube([h + 2, 0.7, outer + 1]);
  }
}

module assembly_preview() {
  color("SteelBlue")   clamp_shell_half(true);
  color("LightSkyBlue") clamp_shell_half(false);
  if (liner_thickness > 0)
    color("DimGray", 0.45) tpu_liner();
}

if (part == "assembly")    assembly_preview();
else if (part == "top_half")    clamp_shell_half(true);
else if (part == "bottom_half") clamp_shell_half(false);
else if (part == "tpu_liner")   tpu_liner();
