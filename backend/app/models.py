from datetime import datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class ThermalEvent(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: UUID
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    detected_at: datetime
    satellite: str
    source: str
    frp: float = Field(ge=0)
    confidence: Literal["l", "n", "h"]
    brightness_ti4: float | None = Field(default=None, gt=0)
    brightness_ti5: float | None = Field(default=None, gt=0)
    day_night: Literal["D", "N"]
    scan: float | None = Field(default=None, gt=0)
    track: float | None = Field(default=None, gt=0)
    ingested_at: datetime


class EventPage(BaseModel):
    status: Literal["ok"] = "ok"
    events: list[ThermalEvent]
    count: int
    offset: int
    truncated: bool
    message: str
