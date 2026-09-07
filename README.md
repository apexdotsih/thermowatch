# ThermoWatch AI

SIH26162 rule-based prototype: real NASA FIRMS observations, an unchanged globe.gl explorer, OSM context, temporal evidence, Supabase/PostGIS history, and a Python ingestion/API path.

## Run it on your computer

Requires Node.js 22.18+ and npm. Extract the source archive and run from the `thermowatch` folder:

```bash
npm ci
npm run dev:next
```

Open http://localhost:3000. The globe fetches real public NASA S-NPP detections without any key. The fictional sample is available only when explicitly selected. Internet access to NASA is required. The first request can take up to a minute.

For a production Node server:

```bash
npm run build:next
npm run start:next
```

## Deploy your own website

The easiest included path is GitHub → Vercel → your domain:

1. Extract the ZIP. Create a GitHub repository and upload the **contents** of `thermowatch/`, including `.github/` and `.env.example`. Never upload a populated `.env`, `node_modules`, or `.venv`.
2. In Vercel, import that repository. Root directory is the repository root. The included `vercel.json` selects Next.js, `npm ci`, and `npm run build:next` automatically.
3. Deploy. The public NASA feed works without credentials; FastAPI is optional for this first explorer.
4. Add your domain in Vercel project settings and apply the DNS records Vercel supplies at your domain provider. Keep your existing website's DNS until you are ready to switch it; a subdomain is an alternative.
5. For persistent history, complete the Supabase steps below and add the same Supabase variables to Vercel's **server-side** environment settings, then redeploy.

This is a server-rendered Next.js application. Uploading the source ZIP into a shared host's `public_html` folder will not run it. Use Vercel or a host with a persistent Node.js process and an HTTPS reverse proxy. Both commands above are included; no code conversion is required.

The current ChatGPT Site uses the Vinext/Sites build (`npm run build`). That platform and the portable Next.js deployment share the same application source. `.openai/hosting.json` identifies the current Site; do not create a different Site with that project ID. The downloadable export clears that identity. Supabase credentials remain environment values and are not included in the export.

## Connect Supabase history

1. Create/select a Supabase project and execute `supabase/migrations/202609060001_thermal_events.sql` in its SQL Editor.
2. Add these server-only environment variables to your web host:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Your project's `https://...supabase.co` URL |
| `SUPABASE_SERVICE_ROLE_KEY` | A server secret (`sb_secret_...`) or legacy `service_role` JWT |

Neither value is compiled into browser JavaScript. Never prefix the secret with `NEXT_PUBLIC_`. Public/anon keys cannot write this table. The migration enables PostGIS, preserves an existing extension schema, adds spatial/time indexes, and blocks anonymous/authenticated table access through RLS and grants.

3. To collect history automatically, add the same two values to **GitHub repository → Settings → Secrets and variables → Actions**.
4. In the Actions tab run **Ingest FIRMS into Supabase** once. Confirm it succeeds. The included workflow requests the real 48-hour NASA public feed every 30 minutes and writes observations with stable IDs. GitHub scheduled jobs may start later than their cron time; they are not a realtime SLA. The workflow is not running in the current ChatGPT-hosted source repository; it becomes active in your own GitHub repository.
5. Refresh the website. It will use Supabase when recent stored observations exist. If the database is empty or unavailable, the site explicitly identifies that history state while continuing with the public NASA feed.

No NASA MAP_KEY is needed for this public-download path. A `FIRMS_MAP_KEY` is needed only for the optional bounded-area/date API ingestion below.

## How the real feed works

- Server endpoint: `/api/events?hours=24&limit=1000` or `hours=168` for seven days.
- Source priority: explicitly configured FastAPI → directly configured Supabase → real NASA public S-NPP CSV.
- The browser checks every five minutes while visible. Server-side public responses are cached for up to five minutes. Refreshing does not create a new satellite observation.
- Each result separates satellite acquisition time, source retrieval time, and database ingestion time. Public observations have no invented database-ingestion timestamp.
- The parser streams the source file, validates signal values and UTC times, accepts both short and spelled-out confidence labels, and reports rejected rows. It retains at most the newest 2,000 records; the UI displays 1,000. The total indicates matching source records, not a fire/incident count. This is a bounded viewer, not every global point rendered simultaneously.
- Satellite availability can lag the overpass by hours. The UI displays the latest observation and flags it as delayed after six hours. Those thresholds describe freshness, not fire risk.
- If a refresh fails, previously loaded points remain visible with an update-failed state. The app never automatically substitutes synthetic records.
- NASA public downloads offer S-NPP coverage in this path. Additional VIIRS spacecraft are available through the Python Area API ingest.

## Optional FastAPI and Area API ingestion

FastAPI remains included for subsequent geospatial intelligence and model inference. It is optional for the current live-feed viewer, which can access Supabase from its own server.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.lock
```

Create a private `.env` from `.env.example`. With the Supabase variables set, keyless ingestion is:

```bash
python -m ingestion.firms.run --public-feed
```

For NASA's Area API, request a [MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/map_key/) and set `FIRMS_MAP_KEY`:

```bash
python -m ingestion.firms.run --area 68,6,98,38 --days 2
python -m ingestion.firms.run --source VIIRS_NOAA20_NRT --area world --days 2
```

For FastAPI set a long random `THERMOWATCH_API_TOKEN` and run:

```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

To route the frontend through that service, set `THERMOWATCH_API_URL` to its HTTPS origin and set the same `THERMOWATCH_API_TOKEN` on the frontend server. These two variables override direct Supabase reads. Omit both unless you have deployed FastAPI. The Python `backend/Dockerfile` and `docker-compose.yml` are included. Build the container with the repository root as build context. `/health` is liveness only; `/v1/events` and `/v1/events/{uuid}` require the bearer token. `/docs` documents the Python API.

Ingestion uses overlapping windows and ignores duplicate IDs. A partial batch failure can leave earlier batches committed; repeating the job is safe. The submitted count is not an inserted count. Historical/standard-processing revision handling is future work.

## Code locations and validation

| Path | Purpose |
| --- | --- |
| `app/`, `components/`, `lib/thermal.ts` | React explorer and globe |
| `lib/server/observation-feed.ts` | Streaming NASA feed and Supabase reads |
| `backend/app/` | Python API and database adapter |
| `ingestion/firms/` | NASA ingestion CLI |
| `supabase/migrations/` | PostgreSQL/PostGIS schema |
| `.github/workflows/ingest.yml` | Scheduled durable ingestion on your GitHub repo |
| `vercel.json` | Portable Next.js deployment |

```bash
npm run test:feed
npm run test:classification
npx tsc --noEmit
python -m unittest discover -s backend/tests -v
npm run build:next
```

Feed tests exercise chunk boundaries, full confidence labels, malformed rows, bounded memory, source fallback, and server-only Supabase credentials. Python tests cover UTC/deduplication, HTTP batches, API authorization, query bounds, and failure handling. Real NASA CSV parsing has been exercised. The seven-day history check processed 668,409 source rows for 1,000 targets, and the OSM geometry path was checked against a real Jamnagar-area response. The Sites production build and TypeScript check pass. A standard Next.js build was attempted here but blocked by this sandbox’s unavailable OS memory introspection (`uv_resident_set_memory`), before compilation. Validate that separate build on Vercel or your local computer before switching your domain. Supabase migration/write verification requires your database access. Rule-based classifications and possible OSM facility associations are now available. They are provisional, not independently verified incidents.

## References and reuse

- [NASA public active-fire downloads](https://firms.modaps.eosdis.nasa.gov/active_fire/)
- [NASA VIIRS attributes](https://www.earthdata.nasa.gov/data/tools/firms/active-fire-data-attributes-modis-viirs)
- [Supabase PostGIS](https://supabase.com/docs/guides/database/extensions/postgis)
- [globe.gl](https://globe.gl/) is the globe library already used by this project. Its point, hover, and camera APIs power the observation view. Country outlines come from world-atlas/Natural Earth.
- [fmhc/strategic-osint-dashboard](https://github.com/fmhc/strategic-osint-dashboard) is MIT-licensed and useful for update/health presentation ideas. Its inspected `modules/firms-monitor.js` **simulates** hotspots. None of that simulator or its implied incident labels are used here. No source code from that repository has been copied.

Future validation work includes satellite-derived land-cover products such as WorldCover, longer durable temporal baselines, labeled incident evaluation, and calibrated ML. A FIRMS point is a thermal observation, not confirmation that a named facility is on fire.


## Classification and enrichment

The original globe, theme, typography, panel geometry and detection point size are retained. Additions are six class colors, matching counters, an evidence section in the existing detail sheet, a Filters dropdown with CSV/GeoJSON export, and a Focus on India camera control. Counters and exports reflect **visible loaded observations**, not all global detections. Natural Fires combines forest and agricultural candidates; mining is counted separately. The ≥80% industrial filter includes industrial fire, persistent sources and mining. Exported scores are not probabilities.

`lib/classification.ts` is a deterministic, versioned rule engine. Every point receives a class, including Unknown when evidence is insufficient. FIRMS confidence describes the satellite signal; the new rule confidence describes support for a candidate source type and is explicitly uncalibrated.

| Candidate | Evidence required |
| --- | --- |
| Industrial Fire | Mapped industry within 1 km, at least 4 earlier active days spanning 3 days, at least 3 comparable baseline days, FRP ≥30 MW and ≥3× baseline, I4−I5 ≥20 K |
| Persistent Thermal Source | Mapped industry within 1 km, repeated earlier activity, FRP 0.4–2.5× baseline, no forest/agricultural conflict |
| Forest / Wildfire | Point inside locally returned OSM forest/wood polygon, thermal contrast ≥10 K, no nearby mapped industry |
| Agricultural Burning | Point inside mapped farmland/orchard/vineyard/nursery, thermal contrast ≥10 K, no nearby mapped industry or established repeated pattern |
| Mining Activity | Mapped quarry containment or nearby mapped mine plus repeated earlier activity |
| Unknown | Insufficient, missing, or conflicting evidence |

Day/night and FIRMS confidence adjust support scores. I4/I5 are thermal signal evidence, not facility identity. A mapped gas flare or power plant can supply a subtype but cannot by itself establish persistence. Four days of activity in a seven-day feed do not prove a permanently operating source.

### Live OSM context

`POST /api/intelligence/context` accepts up to 200 numeric locations in at most eight spatial tiles. It queries the public Overpass API sequentially in the browser with spacing, bounded server timeouts/response size, and a disposable six-hour tile cache. A per-runtime daily budget of 90 requests / 9 MB limits public-service use; context can remain incomplete when that budget is reached. This is a small owner-private demo, not a scalable public enrichment service. India observations are prioritized; opening a record moves its pending lookup forward. Slow enrichment leaves the NASA feed usable. The documented public VK Maps Overpass service supplies OSM data; server/network failure falls back to overpass-api.de, with a ten-minute primary-endpoint backoff. Both previously tested overpass-api.de and Private.coffee were unavailable from the live host, so VK Maps is the preferred endpoint. HTTP 4xx responses (including rate limits) do not trigger endpoint switching. Two consecutive failed batches pause the queue; **Filters → Retry enrichment** retries it. The status line reports coverage rather than implying every point has mapped context.

Facility distance uses returned point or polygon geometry (distance to boundary, zero inside), not an industrial polygon's center. OSM name and source link appear in the card. Association search is limited to 2 km. Multipolygon holes are respected. The 4 km tile query may omit very large enclosing areas whose boundaries lie beyond it; incomplete/tainted geometry is excluded. Unmapped and unavailable context are distinct, and absence of an OSM feature is not proof of absence of industry.

Land context currently comes from **OSM landuse/natural polygons**, not classified satellite imagery or WorldCover. OSM coverage, tag quality, public-service rate limits and availability affect classification completeness. For larger production use, replace public Overpass lookups with a maintained OSM/PostGIS extract and cache. OSM attribution and ODbL links are included. Classified exports retain evidence provenance and uncertainty.

### Temporal evidence

`POST /api/intelligence/history` streams NASA's current seven-day S-NPP CSV once per batch of up to 1,000 targets. It matches observations within 750 m, excludes the target's preceding 24 hours and future records, counts distinct UTC days, and uses a median of daily maximum FRP for the same satellite and day/night. At least three comparable days are required for a baseline. This avoids counting adjacent pixels as repeated days. The fixed current seven-day source gives a shorter preceding baseline for older observations; clouds, missing overpasses and spatial uncertainty also limit evidence. Targets above 85° latitude are left unavailable. NOAA20/21 targets may have S-NPP repeat-day context but no comparable FRP baseline, so industrial incident/persistence rules stay Unknown. This disposable lookup is separate from durable Supabase ingestion.

The explicitly selected sample contains twelve fictional India-focused scenarios covering all six categories. Facility names and histories are marked fictional. Sample evidence never enters NASA or Supabase records.

### Validation scope

`npm run test:classification` covers all six demo classes, evidence gating, industrial FRP anomalies, confidence penalties, geometry containment and holes, dateline distance, unavailable OSM, temporal deduplication and baseline comparability, combined filters, GeoJSON coordinates and spreadsheet formula escaping. This is implementation validation, **not measured classification accuracy**. A labeled, independently verified dataset and expert review are required before operational incident decisions.
