"""Validate VIIRS CSV and produce reproducible observation IDs.

FIRMS detection confidence is deliberately kept separate from model confidence.
No labels or incident/facility attributions are fabricated here.
"""
import csv
import io
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5
from backend.app.models import ThermalEvent

SOURCES = {"VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"}
REQUIRED = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "frp", "confidence", "daynight", "scan", "track", "bright_ti4", "bright_ti5"}


def parse_csv(payload: str, source: str, ingested_at: datetime | None = None) -> list[dict]:
    if source not in SOURCES:
        raise ValueError("Only supported VIIRS NRT sources are accepted.")
    reader = csv.DictReader(io.StringIO(payload.lstrip("\ufeff")))
    if not reader.fieldnames or not REQUIRED.issubset(reader.fieldnames):
        raise ValueError("FIRMS response is not a valid VIIRS CSV (check key, source, and quota).")
    received = ingested_at or datetime.now(timezone.utc)
    if received.tzinfo is None:
        raise ValueError("Ingestion timestamp must have a timezone.")
    records: dict[str, dict] = {}
    for line, row in enumerate(reader, start=2):
        try:
            time = row["acq_time"].strip()
            if not time.isdigit() or len(time) > 4:
                raise ValueError("Invalid acquisition time")
            detected_at = datetime.strptime(f"{row['acq_date']} {time.zfill(4)}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
            latitude, longitude = float(row["latitude"]), float(row["longitude"])
            scan, track = float(row["scan"]), float(row["track"])
            satellite = row["satellite"].strip().upper()
            # NASA now uses N20/N21; historical CSVs used 1/2. Normalize before hashing.
            satellite = {"1": "N20", "2": "N21"}.get(satellite, satellite)
            expected_satellite = {"VIIRS_SNPP_NRT": "N", "VIIRS_NOAA20_NRT": "N20", "VIIRS_NOAA21_NRT": "N21"}[source]
            if satellite != expected_satellite:
                raise ValueError("Satellite does not match requested source")
            identity = f"firms:{source}:{satellite}:{detected_at.isoformat()}:{latitude:.6f}:{longitude:.6f}:{scan}:{track}"
            event = ThermalEvent(
                id=uuid5(NAMESPACE_URL, identity), latitude=latitude, longitude=longitude,
                detected_at=detected_at, satellite={"N":"S-NPP", "N20":"NOAA-20", "N21":"NOAA-21"}[satellite],
                source=source, frp=float(row["frp"]), confidence={"low":"l","nominal":"n","high":"h"}.get(row["confidence"].strip().lower(),row["confidence"].strip().lower()),
                brightness_ti4=float(row["bright_ti4"]), brightness_ti5=float(row["bright_ti5"]),
                day_night=row["daynight"].strip().upper(), scan=scan, track=track, ingested_at=received,
            )
            record = event.model_dump(mode="json")
            record["raw_payload"] = row
            records[record["id"]] = record
        except (ValueError, TypeError, KeyError):
            # Fail before writing any batch; do not silently discard malformed observations.
            raise ValueError(f"Invalid VIIRS observation at CSV line {line}; no records from this response were written.") from None
    return list(records.values())
