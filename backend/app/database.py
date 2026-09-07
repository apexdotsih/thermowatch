from datetime import datetime
from uuid import UUID
import httpx
from .config import Settings

EVENT_COLUMNS = "id,latitude,longitude,detected_at,satellite,source,frp,confidence,brightness_ti4,brightness_ti5,day_night,scan,track,ingested_at"


class DatabaseUnavailable(RuntimeError):
    pass


class SupabaseStore:
    """Server-only PostgREST adapter. Spatial indexing stays in PostGIS."""
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.client = client
        self.url = settings.supabase_url.rstrip("/")
        self.key = settings.supabase_service_role_key.get_secret_value()

    async def request(self, method: str, params=None, body=None, prefer=""):
        if not self.url or not self.key:
            raise DatabaseUnavailable("Database is not configured.")
        headers = {"apikey": self.key}
        if not self.key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {self.key}"
        if prefer:
            headers["Prefer"] = prefer
        try:
            response = await self.client.request(
                method, f"{self.url}/rest/v1/thermal_events", params=params,
                json=body, headers=headers,
            )
            response.raise_for_status()
            return response
        except httpx.HTTPError:
            # Never surface URLs, authorization headers, or provider response bodies.
            raise DatabaseUnavailable("Database request failed.") from None

    async def list_events(self, since: datetime, until: datetime, limit: int, offset: int):
        params = [
            ("select", EVENT_COLUMNS), ("detected_at", f"gte.{since.isoformat()}"),
            ("detected_at", f"lte.{until.isoformat()}"), ("order", "detected_at.desc,id.asc"),
            ("limit", str(limit)), ("offset", str(offset)),
        ]
        response = await self.request("GET", params=params, prefer="count=exact")
        try:
            rows = response.json()
            count = int(response.headers["content-range"].rsplit("/", 1)[1])
            if not isinstance(rows, list):
                raise ValueError
        except (KeyError, ValueError, TypeError):
            raise DatabaseUnavailable("Database returned an invalid page.") from None
        return rows, count

    async def get_event(self, event_id: UUID):
        response = await self.request("GET", params={"select": EVENT_COLUMNS, "id": f"eq.{event_id}", "limit": "1"})
        rows = response.json()
        return rows[0] if rows else None

    async def upsert(self, records: list[dict]) -> int:
        # Existing observations retain their first-ingestion time and source payload.
        # Only NRT products are accepted; retrospective scientific reprocessing is a later pipeline.
        submitted = 0
        for start in range(0, len(records), 500):
            batch = records[start:start + 500]
            await self.request("POST", params={"on_conflict": "id"}, body=batch,
                               prefer="resolution=ignore-duplicates,return=minimal")
            submitted += len(batch)
        return submitted
