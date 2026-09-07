"""Run from repository root: python -m ingestion.firms.run --days 2 --area world."""
import argparse
import asyncio
from datetime import date
import json
import re
import sys
from urllib.parse import quote
import httpx
from backend.app.config import get_settings
from backend.app.database import DatabaseUnavailable, SupabaseStore
from .parser import SOURCES, parse_csv


def area_value(value: str) -> str:
    if value == "world":
        return value
    try:
        west, south, east, north = map(float, value.split(","))
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError
    except ValueError:
        raise argparse.ArgumentTypeError("Area must be world or west,south,east,north with valid ordered bounds.") from None
    return f"{west},{south},{east},{north}"


async def ingest(source: str, area: str, days: int, start_date: date | None, public_feed: bool = False):
    settings = get_settings()
    key = settings.firms_map_key.get_secret_value()
    if not public_feed and (not key or not re.fullmatch(r"[A-Za-z0-9_-]+", key)):
        raise ValueError("Set a valid FIRMS_MAP_KEY in the private environment.")
    if not settings.supabase_url or not settings.supabase_service_role_key.get_secret_value():
        raise ValueError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.")
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{quote(key, safe='')}/{source}/{area}/{days}"
    if start_date:
        url += f"/{start_date.isoformat()}"
    if public_feed:
        if source != "VIIRS_SNPP_NRT" or area != "world" or start_date:
            raise ValueError("Public-feed ingestion supports S-NPP world coverage without a start date.")
        url = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_48h.csv"
    async with httpx.AsyncClient(timeout=90.0) as client:
        try:
            response = await client.get(url)
            response.raise_for_status()
        except httpx.HTTPError:
            raise RuntimeError("FIRMS download failed; check connectivity, key, and API quota.") from None
        records = parse_csv(response.text, source)
        submitted = await SupabaseStore(settings, client).upsert(records)
    # Submitted is deliberately not called inserted; duplicates are ignored by Postgres.
    return {"source": source, "unique_records_submitted": submitted, "area": area, "days": 2 if public_feed else days, "mode": "public_download" if public_feed else "area_api"}


def main():
    parser = argparse.ArgumentParser(description="Ingest validated FIRMS VIIRS NRT detections into Supabase.")
    parser.add_argument("--source", choices=sorted(SOURCES), default="VIIRS_SNPP_NRT")
    parser.add_argument("--area", type=area_value, default="world")
    parser.add_argument("--days", type=int, choices=range(1, 6), default=2)
    parser.add_argument("--start-date", type=date.fromisoformat)
    parser.add_argument("--public-feed", action="store_true", help="Ingest the public 48-hour S-NPP CSV without a MAP_KEY.")
    args = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(ingest(args.source, args.area, args.days, args.start_date, args.public_feed))))
    except (ValueError, RuntimeError, DatabaseUnavailable) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
