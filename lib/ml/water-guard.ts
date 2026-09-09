// Water / sun-glint guard.
//
// Removes the "agricultural fire in the middle of the ocean" class of error.
// Crop, forest and mining fires are physically impossible over open water, and
// sunlight glinting off the sea can mimic a hotspot (a well-known VIIRS/MODIS
// artefact — ISRO's INSAT-3DS fire algorithm masks water and rejects high sun
// glint for the same reason). We do NOT delete every ocean detection: offshore
// platform flares are real, so persistent/hot offshore points are re-routed to
// an offshore-industrial reading instead of being discarded.
import type { ThermalEvent } from "../thermal";

// Coarse land test. A full coastline polygon set is loaded on the globe; this
// bounding-box ocean test is a cheap first-pass that catches deep-ocean points
// (like the mid-Pacific false positive) without any network call.
// Boxes are large open-ocean interiors [west, south, east, north].
const OPEN_OCEAN: [number, number, number, number][] = [
  [-150, -55, -80, 10],   // South Pacific
  [-175, 5, -130, 55],    // North Pacific
  [-45, -55, 10, 5],      // South Atlantic
  [-55, 15, -20, 55],     // North Atlantic
  [45, -55, 95, 5],       // Indian Ocean (south of the subcontinent)
  [52, 8, 67, 23],        // Arabian Sea (kept offshore of the Gujarat coast)
  [84, 6, 94, 18],        // Bay of Bengal interior (kept offshore of the coast)
  [-180, -75, 180, -60],  // Southern Ocean
  [160, -45, 180, 30],    // West Pacific edge
  [-180, -45, -150, 30],  // East Pacific edge
];

function inBox(lat: number, lon: number, b: [number, number, number, number]) {
  return lat >= b[1] && lat <= b[3] && lon >= b[0] && lon <= b[2];
}

export function isLikelyOpenOcean(lat: number, lon: number): boolean {
  return OPEN_OCEAN.some((b) => inBox(lat, lon, b));
}

// Sun-glint risk: bright, low-power, daytime detection over water with no
// persistence is the classic specular-reflection artefact.
export function looksLikeGlint(event: ThermalEvent, persistenceDays: number): boolean {
  return (
    event.day_night === "D" &&
    (event.frp ?? 0) < 15 &&
    persistenceDays < 2
  );
}

export type WaterVerdict =
  | { kind: "land" }                              // proceed normally
  | { kind: "offshore_industrial"; reason: string } // real platform flare
  | { kind: "reject"; reason: string };           // glint / impossible class

export function screenWater(event: ThermalEvent, persistenceDays: number, ratio: number | null): WaterVerdict {
  if (!isLikelyOpenOcean(event.latitude, event.longitude)) return { kind: "land" };

  const ti4 = event.brightness_ti4, ti5 = event.brightness_ti5;
  const delta = ti4 != null && ti5 != null ? ti4 - ti5 : null;
  const hot = delta != null && delta >= 25;
  const persistent = persistenceDays >= 3;
  const strongRatio = ratio != null && ratio >= 2;

  // Genuine offshore flare: persistent and/or very hot over water.
  if (persistent || (hot && (event.frp ?? 0) >= 20) || strongRatio) {
    return {
      kind: "offshore_industrial",
      reason: "Persistent high-temperature source over water — consistent with an offshore platform flare, not a land fire.",
    };
  }
  if (looksLikeGlint(event, persistenceDays)) {
    return {
      kind: "reject",
      reason: "Low-power daytime detection over open water with no recurrence — most consistent with a sun-glint artefact; suppressed.",
    };
  }
  // Over water but not clearly a flare and not clearly glint: cannot be a land
  // fire, so it must not be labelled forest/agriculture/mining.
  return {
    kind: "reject",
    reason: "Detection over open water cannot be a vegetation, crop or mining fire; land-based classes suppressed.",
  };
}
