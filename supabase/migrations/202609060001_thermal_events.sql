-- Run once in the Supabase SQL editor. No destructive operations.
begin;
create schema if not exists extensions;
create extension if not exists postgis with schema extensions;

-- Respect an existing PostGIS installation in another schema (e.g. gis).
select set_config('search_path', 'public,' || quote_ident(n.nspname) || ',pg_catalog', true)
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'postgis';

create table if not exists public.thermal_events (
    id uuid primary key,
    latitude double precision not null check (latitude between -90 and 90),
    longitude double precision not null check (longitude between -180 and 180),
    detected_at timestamptz not null,
    satellite text not null check (satellite in ('S-NPP', 'NOAA-20', 'NOAA-21')),
    source text not null check (source in ('VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT')),
    frp double precision not null check (frp >= 0 and frp < 'Infinity'::float8),
    brightness_ti4 double precision check (brightness_ti4 > 0 and brightness_ti4 < 'Infinity'::float8),
    brightness_ti5 double precision check (brightness_ti5 > 0 and brightness_ti5 < 'Infinity'::float8),
    confidence text not null check (confidence in ('l', 'n', 'h')),
    day_night text not null check (day_night in ('D', 'N')),
    scan double precision check (scan > 0 and scan < 'Infinity'::float8),
    track double precision check (track > 0 and track < 'Infinity'::float8),
    location geography(Point, 4326) generated always as
      (st_setsrid(st_makepoint(longitude, latitude), 4326)::geography) stored,
    raw_payload jsonb not null,
    ingested_at timestamptz not null default now()
);

create index if not exists thermal_events_location_idx on public.thermal_events using gist (location);
create index if not exists thermal_events_detected_at_idx on public.thermal_events (detected_at desc, id);

alter table public.thermal_events enable row level security;
-- No browser/anonymous database access. FastAPI and ingestion use the server-only role.
revoke all on public.thermal_events from anon, authenticated;
grant select, insert on public.thermal_events to service_role;
comment on table public.thermal_events is 'Raw FIRMS observations, not confirmed incidents or facility attributions.';
notify pgrst, 'reload schema';
commit;
