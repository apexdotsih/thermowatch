export type ThermalEvent = {
  id: string; latitude: number; longitude: number; detected_at: string;
  satellite: string; source: string; frp: number; confidence: string;
  brightness_ti4: number | null; brightness_ti5: number | null;
  day_night: "D" | "N"; scan: number | null; track: number | null; ingested_at: string | null; retrieved_at?: string;
};
export type EventResponse = {
  status: "ok" | "not_configured"; events: ThermalEvent[]; truncated?: boolean; message?: string;
  count?: number; source_mode?: "nasa_public" | "supabase" | "fastapi";
  persistence?: "not_configured" | "connected" | "empty" | "unavailable";
  fetched_at?: string; latest_observation?: string | null; stale?: boolean; rejected_rows?: number;
};
// Deliberately fictional, fixed-date fixtures. Never ingest these into the live database.
const SAMPLE_NOW = Date.now();

export const sampleEvents: ThermalEvent[] = ([
  // Curated Indian demonstration set. Coordinates are real locations; the
  // thermal values are fictional fixtures, never satellite observations.
  // [lat, lon, frp, ti4, ti5, day/night, minutes-ago]
  // — Industrial fire candidates (major refinery / steel complexes)
  [22.3400, 69.8500, 148, 372, 305, "N", 41],
  [22.4700, 69.7200, 96, 366, 303, "N", 88],
  [22.7800, 86.2000, 132, 370, 304, "N", 132],
  [22.2200, 84.8800, 74, 361, 301, "D", 176],
  [21.1100, 72.6500, 88, 364, 302, "N", 214],
  [20.3000, 86.6100, 61, 358, 300, "N", 263],
  // — Persistent thermal sources (continuous flares / smelters)
  [22.4000, 73.1500, 21, 342, 299, "N", 52],
  [21.7000, 72.5800, 18, 340, 298, "N", 97],
  [19.0000, 72.8900, 24, 344, 300, "N", 149],
  [21.2000, 81.3800, 26, 345, 300, "N", 188],
  [20.8400, 85.1000, 17, 339, 298, "N", 235],
  [17.6800, 83.2000, 22, 343, 299, "N", 289],
  [13.1600, 80.2600, 19, 341, 298, "N", 334],
  [25.4800, 85.9700, 15, 338, 297, "N", 388],
  // — Mining activity
  [22.3500, 82.7000, 34, 349, 300, "D", 64],
  [23.7500, 86.4200, 47, 353, 301, "N", 121],
  [20.9500, 85.2200, 29, 347, 299, "D", 205],
  [24.1000, 82.6700, 38, 351, 300, "D", 271],
  [15.1500, 76.6000, 25, 344, 299, "D", 356],
  // — Forest / wildfire
  [21.9000, 86.3500, 84, 360, 302, "D", 73],
  [11.6700, 76.6300, 112, 366, 303, "D", 118],
  [19.6000, 73.5500, 46, 352, 300, "D", 163],
  [22.3300, 80.6200, 68, 357, 301, "N", 197],
  [19.1000, 81.9500, 57, 355, 301, "D", 244],
  [11.4000, 76.7000, 39, 350, 300, "D", 298],
  [29.3800, 79.4500, 92, 362, 302, "D", 347],
  [26.7200, 91.0000, 51, 354, 300, "N", 401],
  // — Agricultural burning (crop-residue belts)
  [30.9000, 75.8500, 11, 331, 296, "D", 58],
  [30.2500, 75.8400, 8, 329, 295, "D", 104],
  [29.6900, 76.9900, 14, 333, 297, "D", 158],
  [29.0000, 77.7000, 6, 327, 295, "D", 209],
  [26.7600, 83.3700, 12, 332, 296, "D", 256],
  [26.1200, 85.3900, 9, 330, 295, "D", 311],
  [23.2500, 87.8500, 16, 334, 297, "D", 365],
  [20.0000, 73.7900, 7, 328, 295, "D", 412],
  [16.3000, 80.4400, 13, 333, 296, "D", 448],
] as [number, number, number, number, number, "D" | "N", number][]).map(
  ([latitude, longitude, frp, ti4, ti5, dayNight, minutesAgo], i) => ({
    id: `synthetic-${String(i + 1).padStart(3, "0")}`, latitude, longitude, frp,
    detected_at: new Date(SAMPLE_NOW - minutesAgo * 60000).toISOString().slice(0, 19) + "Z",
    ingested_at: new Date(SAMPLE_NOW - Math.max(0, minutesAgo - 25) * 60000).toISOString().slice(0, 19) + "Z",
    satellite: i % 3 === 0 ? "NOAA-20" : "S-NPP", source: "SYNTHETIC_FIXTURE",
    confidence: frp >= 40 ? "h" : "n", day_night: dayNight,
    brightness_ti4: ti4, brightness_ti5: ti5, scan: 0.42, track: 0.39,
  }));
