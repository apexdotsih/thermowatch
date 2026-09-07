from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import hmac
from uuid import UUID
import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import JSONResponse
from .config import get_settings
from .database import DatabaseUnavailable, SupabaseStore
from .models import EventPage, ThermalEvent


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=30.0) as client:
        app.state.http_client = client
        yield


app = FastAPI(title="ThermoWatch API", version="0.1.0", lifespan=lifespan)
bearer = HTTPBearer(auto_error=False)


def authorize(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    expected = get_settings().thermowatch_api_token.get_secret_value()
    if not expected:
        raise HTTPException(503, "API authentication is not configured.")
    if not credentials or not hmac.compare_digest(credentials.credentials.encode(), expected.encode()):
        raise HTTPException(401, "Invalid API token.", headers={"WWW-Authenticate": "Bearer"})


def get_store(request: Request):
    return SupabaseStore(get_settings(), request.app.state.http_client)


@app.exception_handler(DatabaseUnavailable)
async def database_error(_request, _error):
    return JSONResponse(status_code=503, content={"detail": "Observation database is unavailable."})


@app.get("/health")
def health():
    # Liveness only, not a claim that ingestion/database are healthy.
    return {"status": "ok", "service": "thermowatch", "version": "0.1.0"}


@app.get("/v1/events", response_model=EventPage, dependencies=[Depends(authorize)])
async def list_events(
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(1000, ge=1, le=1000),
    offset: int = Query(0, ge=0, le=1000000),
    store: SupabaseStore = Depends(get_store),
):
    now = datetime.now(timezone.utc)
    rows, count = await store.list_events(now - timedelta(hours=hours), now, limit, offset)
    return EventPage(events=rows, count=count, offset=offset, truncated=offset + len(rows) < count,
                     message="Stored satellite observations. Acquisition and ingestion times are separate; refresh does not trigger a satellite pass.")


@app.get("/v1/events/{event_id}", response_model=ThermalEvent, dependencies=[Depends(authorize)])
async def event_detail(event_id: UUID, store: SupabaseStore = Depends(get_store)):
    event = await store.get_event(event_id)
    if event is None:
        raise HTTPException(404, "Observation not found.")
    return event
