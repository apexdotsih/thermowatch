import type { EventResponse, ThermalEvent } from "../thermal";

export type FeedConfig = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  THERMOWATCH_API_URL?: string;
  THERMOWATCH_API_TOKEN?: string;
  // Optional "west,south,east,north" region of interest. The newest global
  // observations often come from a single recent overpass swath, so a purely
  // global page can exclude a region entirely. When set, a share of each page
  // is reserved for the newest observations inside this box. Coverage stays
  // global; the region is guaranteed representation, not exclusivity.
  FOCUS_BBOX?: string;
};
export type FeedQuery = { hours: number; limit: number; offset: number };
const NASA_BASE =
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/";
const COLUMNS =
  "id,latitude,longitude,detected_at,satellite,source,frp,confidence,brightness_ti4,brightness_ti5,day_night,scan,track,ingested_at";
const TTL = 5 * 60 * 1000;
// A bounded, disposable public-feed cache. Supabase remains the durable store.
const publicCache = new Map<number, { expires: number; page: EventResponse }>();
const pending = new Map<number, Promise<EventResponse>>();

function fields(line: string): string[] {
  const result: string[] = [];
  let value = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      result.push(value.trim());
      value = "";
    } else value += c;
  }
  if (quoted) throw new Error("Malformed CSV");
  result.push(value.trim());
  return result;
}

export function parseObservation(
  row: Record<string, string>,
  fetchedAt: string,
): ThermalEvent {
  const number = (name: string) => {
    if (!row[name]?.trim()) throw new Error("Missing signal");
    const n = Number(row[name]);
    if (!Number.isFinite(n)) throw new Error("Invalid signal");
    return n;
  };
  const latitude = number("latitude"),
    longitude = number("longitude"),
    frp = number("frp");
  const scan = number("scan"),
    track = number("track"),
    i4 = number("bright_ti4"),
    i5 = number("bright_ti5");
  const time = row.acq_time?.padStart(4, "0");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.acq_date) || !/^\d{4}$/.test(time))
    throw new Error("Invalid date");
  const timestamp = `${row.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`;
  const ms = Date.parse(timestamp);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 16) !== timestamp.slice(0, 16)
  )
    throw new Error("Invalid date");
  const confidence = (
    { low: "l", nominal: "n", high: "h", l: "l", n: "n", h: "h" } as Record<
      string,
      string
    >
  )[row.confidence?.toLowerCase()];
  if (
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    frp < 0 ||
    Math.min(scan, track, i4, i5) <= 0 ||
    !confidence ||
    !["D", "N"].includes(row.daynight) ||
    row.satellite !== "N"
  )
    throw new Error("Invalid VIIRS record");
  return {
    id: `firms-snpp:${timestamp}:${latitude.toFixed(6)}:${longitude.toFixed(6)}:${scan}:${track}`,
    latitude,
    longitude,
    frp,
    detected_at: timestamp,
    satellite: "S-NPP",
    source: "VIIRS_SNPP_NRT",
    confidence,
    brightness_ti4: i4,
    brightness_ti5: i5,
    day_night: row.daynight as "D" | "N",
    scan,
    track,
    ingested_at: null,
    retrieved_at: fetchedAt,
  };
}

const newestFirst = (a: ThermalEvent, b: ThermalEvent) =>
  b.detected_at.localeCompare(a.detected_at) || a.id.localeCompare(b.id);

/**
 * Keep `target` observations, spread evenly across the UTC days covered by the
 * window. A pure newest-first cut collapses a 7-day request into the newest few
 * hours (NASA's 7-day global file is ordered/dominated by recent overpasses),
 * which is why a 24-hour and a 7-day request previously returned the same rows.
 * Single-day windows keep the original newest-first behaviour.
 */
export function retain(
  events: ThermalEvent[],
  hours: number,
  now: number,
  target: number,
): ThermalEvent[] {
  const sorted = [...events].sort(newestFirst);
  const days = Math.ceil(hours / 24);
  if (days <= 1 || sorted.length <= target) return sorted.slice(0, target);
  const buckets = new Map<number, ThermalEvent[]>();
  for (const event of sorted) {
    const age = Math.floor((now - Date.parse(event.detected_at)) / 86400000);
    const day = Math.min(days - 1, Math.max(0, Number.isFinite(age) ? age : 0));
    const list = buckets.get(day);
    if (list) list.push(event);
    else buckets.set(day, [event]);
  }
  const quota = Math.ceil(target / days);
  const kept: ThermalEvent[] = [];
  for (const list of buckets.values()) kept.push(...list.slice(0, quota));
  // Backfill any unused quota (days with sparse coverage) from what remains.
  if (kept.length < target) {
    const chosen = new Set(kept.map((e) => e.id));
    for (const event of sorted) {
      if (kept.length >= target) break;
      if (!chosen.has(event.id)) {
        kept.push(event);
        chosen.add(event.id);
      }
    }
  }
  return kept.sort(newestFirst).slice(0, target);
}

export async function parsePublicFeed(
  response: Response,
  hours: number,
  now = Date.now(),
  onObservation?: (event: ThermalEvent) => void,
): Promise<EventResponse> {
  if (!response.ok || !response.body) throw new Error("NASA feed unavailable");
  const fetchedAt = new Date(now).toISOString(),
    cutoff = now - hours * 3600000;
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    header: string[] | null = null,
    bytes = 0,
    count = 0,
    invalid = 0,
    latest: string | null = null;
  let candidates = new Map<string, ThermalEvent>();
  const compare = (a: ThermalEvent, b: ThermalEvent) =>
    b.detected_at.localeCompare(a.detected_at) || a.id.localeCompare(b.id);
  const consume = (line: string) => {
    if (!line.trim()) return;
    if (!header) {
      header = fields(line.replace(/^\uFEFF/, ""));
      if (
        ![
          "latitude",
          "longitude",
          "acq_date",
          "acq_time",
          "satellite",
          "confidence",
          "frp",
          "bright_ti4",
          "bright_ti5",
          "daynight",
          "scan",
          "track",
        ].every((k) => header!.includes(k))
      )
        throw new Error("NASA returned an unexpected format");
      return;
    }
    try {
      const values = fields(line);
      if (values.length !== header.length) throw new Error("Malformed row");
      const event = parseObservation(
        Object.fromEntries(header.map((key, i) => [key, values[i]])),
        fetchedAt,
      );
      const time = Date.parse(event.detected_at);
      if (time > now) {
        invalid++;
        return;
      }
      if (!latest || event.detected_at > latest) latest = event.detected_at;
      if (time < cutoff) return;
      count++;
      if (onObservation) {
        onObservation(event);
        return;
      }
      candidates.set(event.id, event);
      // Stream a potentially large seven-day file without retaining all source rows.
      // Retention is spread across UTC day buckets so a multi-day window keeps
      // observations from every day, not only the newest hours.
      if (candidates.size > 4000)
        candidates = new Map(
          retain([...candidates.values()], hours, now, 2000).map((e) => [
            e.id,
            e,
          ]),
        );
    } catch {
      invalid++;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 100 * 1024 * 1024)
        throw new Error("NASA feed exceeded the supported size");
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 16384) throw new Error("Unexpected NASA response");
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!header) throw new Error("NASA returned an empty response");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const events = retain([...candidates.values()], hours, now, 2000);
  return {
    status: "ok",
    events,
    count,
    truncated: count > events.length,
    source_mode: "nasa_public",
    persistence: "not_configured",
    fetched_at: fetchedAt,
    latest_observation: latest,
    stale: !!latest && now - Date.parse(latest) > 6 * 3600000,
    rejected_rows: invalid,
    message:
      "NASA S-NPP observations. Satellite data can arrive several hours after an overpass.",
  };
}

async function nasa(
  hours: number,
  fetcher: typeof fetch,
): Promise<EventResponse> {
  const cached = publicCache.get(hours);
  if (cached && cached.expires > Date.now()) return cached.page;
  if (pending.has(hours)) return pending.get(hours)!;
  const task = (async () => {
    const suffix = hours > 24 ? "7d" : "24h";
    const response = await fetcher(
      `${NASA_BASE}SUOMI_VIIRS_C2_Global_${suffix}.csv`,
      { signal: AbortSignal.timeout(55000) },
    );
    const page = await parsePublicFeed(response, hours);
    publicCache.set(hours, { page, expires: Date.now() + TTL });
    return page;
  })();
  pending.set(hours, task);
  try {
    return await task;
  } finally {
    pending.delete(hours);
  }
}

export async function readFeed(
  config: FeedConfig,
  query: FeedQuery,
  fetcher: typeof fetch = fetch,
): Promise<EventResponse> {
  let persistence: EventResponse["persistence"] = "not_configured";
  const hasBackend = !!(
    config.THERMOWATCH_API_URL && config.THERMOWATCH_API_TOKEN
  );
  const hasSupabase = !!(
    config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY
  );
  if (hasBackend || hasSupabase) {
    try {
      let result: EventResponse;
      if (hasBackend) {
        const url = new URL(
          `${config.THERMOWATCH_API_URL!.replace(/\/$/, "")}/v1/events`,
        );
        Object.entries(query).forEach(([k, v]) =>
          url.searchParams.set(k, String(v)),
        );
        const response = await fetcher(url, {
          headers: { Authorization: `Bearer ${config.THERMOWATCH_API_TOKEN}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Backend unavailable");
        result = (await response.json()) as EventResponse;
      } else {
        const key = config.SUPABASE_SERVICE_ROLE_KEY!;
        const since = new Date(
            Date.now() - query.hours * 3600000,
          ).toISOString(),
          until = new Date().toISOString();
        const ask = async (limit: number, offset: number, bbox?: number[]) => {
          const url = new URL(
            `${config.SUPABASE_URL!.replace(/\/$/, "")}/rest/v1/thermal_events`,
          );
          url.searchParams.set("select", COLUMNS);
          url.searchParams.append("detected_at", `gte.${since}`);
          url.searchParams.append("detected_at", `lte.${until}`);
          if (bbox) {
            const [w, s2, e, n] = bbox;
            url.searchParams.append("longitude", `gte.${w}`);
            url.searchParams.append("longitude", `lte.${e}`);
            url.searchParams.append("latitude", `gte.${s2}`);
            url.searchParams.append("latitude", `lte.${n}`);
          }
          url.searchParams.set("order", "detected_at.desc,id.asc");
          url.searchParams.set("limit", String(limit));
          url.searchParams.set("offset", String(offset));
          const response = await fetcher(url, {
            headers: {
              apikey: key,
              ...(!key.startsWith("sb_secret_")
                ? { Authorization: `Bearer ${key}` }
                : {}),
              Prefer: "count=exact",
            },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error("Supabase unavailable");
          const rows = (await response.json()) as ThermalEvent[];
          const total = Number(
            response.headers.get("content-range")?.split("/").pop(),
          );
          if (!Array.isArray(rows) || !Number.isFinite(total))
            throw new Error("Invalid database response");
          return { rows, total };
        };
        // Read from config first (testable), else fall back to the server env so
        // no change to app/api/events/route.ts is required.
        const focusRaw =
          config.FOCUS_BBOX ??
          (typeof process !== "undefined"
            ? process.env?.FOCUS_BBOX
            : undefined) ??
          "";
        const focus = focusRaw.split(",").map(Number);
        const useFocus =
          focus.length === 4 &&
          focus.every(Number.isFinite) &&
          query.offset === 0;
        // Reserve up to a quarter of the first page for the region of interest.
        const reserved = useFocus
          ? Math.min(250, Math.floor(query.limit / 4))
          : 0;
        const global = await ask(query.limit - reserved, query.offset);
        let events = global.rows;
        if (reserved > 0) {
          try {
            const region = await ask(reserved, 0, focus);
            const seen = new Set(events.map((e) => e.id));
            events = [
              ...events,
              ...region.rows.filter((e) => !seen.has(e.id)),
            ].sort(
              (a, b) =>
                b.detected_at.localeCompare(a.detected_at) ||
                a.id.localeCompare(b.id),
            );
          } catch {
            /* region query is best-effort; global results still stand */
          }
        }
        result = {
          status: "ok",
          events,
          count: global.total,
          truncated: query.offset + global.rows.length < global.total,
        };
      }
      if (!Array.isArray(result.events))
        throw new Error("Invalid backend response");
      if (result.events.length || query.offset > 0) {
        const latest = result.events[0]?.detected_at ?? null;
        return {
          ...result,
          source_mode: hasBackend ? "fastapi" : "supabase",
          persistence: "connected",
          fetched_at: new Date().toISOString(),
          latest_observation: latest,
          stale: !!latest && Date.now() - Date.parse(latest) > 6 * 3600000,
          message:
            "Observations from Supabase history. Acquisition time is the satellite overpass time.",
        };
      }
      persistence = "empty";
    } catch {
      persistence = "unavailable";
    }
  }
  const page = await nasa(query.hours, fetcher);
  // Select the page across the whole requested window; a plain newest-first
  // slice would return only the most recent hours for a 7-day request.
  const window = retain(
    page.events,
    query.hours,
    Date.now(),
    query.offset + query.limit,
  );
  return {
    ...page,
    persistence,
    events: window.slice(query.offset, query.offset + query.limit),
    truncated: (page.count ?? 0) > query.offset + query.limit,
  };
}
