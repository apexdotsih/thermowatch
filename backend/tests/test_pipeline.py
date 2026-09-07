import asyncio
import csv
import io
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from backend.app.config import Settings, get_settings
from backend.app.database import DatabaseUnavailable, SupabaseStore
from backend.app.main import app, get_store
from ingestion.firms.parser import parse_csv
from ingestion.firms.run import area_value

SOURCE = "VIIRS_SNPP_NRT"
ROW = dict(latitude="23.12", longitude="72.61", bright_ti4="330.2", scan="0.42", track="0.39",
           acq_date="2026-01-15", acq_time="3", satellite="N", instrument="VIIRS", confidence="n",
           version="2.0NRT", bright_ti5="294.8", frp="18.4", daynight="N")


def payload(rows=None):
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=ROW.keys())
    writer.writeheader()
    writer.writerows([ROW] if rows is None else rows)
    return stream.getvalue()


class ParserTests(unittest.TestCase):
    def test_utc_and_stable_identity_across_reingestion(self):
        first = parse_csv(payload(), SOURCE, datetime(2026, 1, 16, tzinfo=timezone.utc))[0]
        second = parse_csv(payload(), SOURCE, datetime(2026, 1, 17, tzinfo=timezone.utc))[0]
        self.assertEqual(first["detected_at"], "2026-01-15T00:03:00Z")
        self.assertEqual(first["id"], second["id"])
        self.assertNotEqual(first["ingested_at"], second["ingested_at"])
        self.assertEqual(first["raw_payload"], ROW)

    def test_current_and_legacy_satellite_codes_deduplicate(self):
        for legacy, current, source in [("1", "N20", "VIIRS_NOAA20_NRT"), ("2", "N21", "VIIRS_NOAA21_NRT")]:
            records = parse_csv(payload([{**ROW, "satellite": legacy}, {**ROW, "satellite": current}]), source)
            self.assertEqual(len(records), 1)

    def test_duplicates_removed_but_distinct_acquisitions_preserved(self):
        records = parse_csv(payload([ROW, ROW, {**ROW, "acq_time": "4"}]), SOURCE)
        self.assertEqual(len(records), 2)

    def test_bad_provider_response_and_empty_csv(self):
        for text in ["Invalid MAP_KEY", "<html>Quota exceeded</html>", ""]:
            with self.assertRaises(ValueError): parse_csv(text, SOURCE)
        self.assertEqual(parse_csv(payload([]), SOURCE), [])

    def test_reject_invalid_signal_and_mismatched_satellite(self):
        for field, value in [("latitude", "91"), ("longitude", "nan"), ("frp", "inf"), ("frp", "-1"),
                             ("acq_time", "2400"), ("confidence", "80"), ("daynight", "X"),
                             ("satellite", "N20"), ("scan", "0")]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                parse_csv(payload([{**ROW, field: value}]), SOURCE)

    def test_area_validation(self):
        self.assertEqual(area_value("world"), "world")
        self.assertEqual(area_value("68,6,98,38"), "68.0,6.0,98.0,38.0")
        for area in ["north", "90,20,10,30", "-181,0,30,20", "nan,0,30,20"]:
            with self.assertRaises(Exception): area_value(area)


class StoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_contract_count_and_duplicate_safe_write(self):
        records = parse_csv(payload(), SOURCE)
        requests = []
        def handler(request):
            requests.append(request)
            if request.method == "GET":
                return httpx.Response(200, json=records, headers={"content-range": "0-0/17"})
            return httpx.Response(201)
        settings = Settings(supabase_url="https://example.supabase.co", supabase_service_role_key="test-only")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            store = SupabaseStore(settings, client)
            now = datetime.now(timezone.utc)
            rows, count = await store.list_events(now, now, 10, 0)
            await store.upsert(records * 501)
        self.assertEqual(count, 17)
        self.assertEqual(rows, records)
        self.assertEqual(len(requests), 3)
        self.assertEqual(requests[0].headers["Prefer"], "count=exact")
        self.assertEqual(len(requests[0].url.params.get_list("detected_at")), 2)
        self.assertEqual(requests[1].url.params["on_conflict"], "id")
        self.assertIn("ignore-duplicates", requests[1].headers["Prefer"])
        self.assertEqual(len(json.loads(requests[1].content)), 500)
        self.assertEqual(len(json.loads(requests[2].content)), 1)

    async def test_database_error_hides_provider_body(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(401, text="private-provider-message"))) as client:
            store = SupabaseStore(Settings(supabase_url="https://example.supabase.co", supabase_service_role_key="test-only"), client)
            with self.assertRaises(DatabaseUnavailable) as context:
                await store.upsert(parse_csv(payload(), SOURCE))
            self.assertNotIn("private-provider-message", str(context.exception))


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.records = parse_csv(payload(), SOURCE)
        records = self.records
        class FakeStore:
            async def list_events(self, since, until, limit, offset): return records, 2
            async def get_event(self, event_id): return records[0] if str(event_id) == records[0]["id"] else None
        app.dependency_overrides[get_store] = lambda: FakeStore()
        self.settings = patch("backend.app.main.get_settings", return_value=Settings(thermowatch_api_token="test-token"))
        self.settings.start()
        self.client = TestClient(app)
        self.headers = {"Authorization": "Bearer test-token"}

    def tearDown(self):
        self.client.close()
        self.settings.stop()
        app.dependency_overrides.clear()

    def test_auth_required_and_query_bounds(self):
        self.assertEqual(self.client.get("/v1/events").status_code, 401)
        self.assertEqual(self.client.get("/v1/events", headers={"Authorization":"Bearer incorrect"}).status_code, 401)
        self.assertEqual(self.client.get("/v1/events?hours=721", headers=self.headers).status_code, 422)
        self.assertEqual(self.client.get("/v1/events?limit=1001", headers=self.headers).status_code, 422)

    def test_list_and_detail_contract(self):
        response = self.client.get("/v1/events", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["truncated"])
        self.assertEqual(response.json()["events"][0]["frp"], 18.4)
        self.assertNotIn("raw_payload", response.json()["events"][0])
        event_id = self.records[0]["id"]
        self.assertEqual(self.client.get(f"/v1/events/{event_id}", headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get("/v1/events/00000000-0000-4000-8000-000000000000", headers=self.headers).status_code, 404)
        self.assertEqual(self.client.get("/v1/events/invalid", headers=self.headers).status_code, 422)

    def test_database_unavailable_is_recoverable(self):
        class BrokenStore:
            async def list_events(self, *args): raise DatabaseUnavailable("private diagnostics")
        app.dependency_overrides[get_store] = lambda: BrokenStore()
        response = self.client.get("/v1/events", headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private diagnostics", response.text)


if __name__ == "__main__":
    unittest.main()
