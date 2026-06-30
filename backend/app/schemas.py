"""Pydantic-схеми для валідації запитів та формату відповідей API."""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


# --- Boiler ---
class BoilerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


# --- House ---
class HouseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    personal_account: str | None = None
    owner: str | None = None
    address: str | None = None
    settlement: str | None = None
    boiler_id: int | None = None
    meter_no: str | None = None
    meter_type: str | None = None
    unit: str
    heat_load: float
    share: float
    commercial_metering: bool


class HouseDetail(HouseOut):
    """Будинок + останнє показання (для автозаповнення попередніх значень)."""

    last_energy_reading: float = 0.0
    last_measure_date: date | None = None


# --- Reading ---
class ReadingBase(BaseModel):
    measure_date: date | None = None
    is_control: bool = False
    duration_hours: float = Field(0, ge=0)
    t_avg: float = 0.0
    energy_current: float = Field(0, ge=0)


class ReadingCreate(ReadingBase):
    house_id: int
    # Якщо не передано — береться останнє показання будинку
    energy_previous: float | None = None


class ReadingOut(ReadingBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    house_id: int
    unit: str
    energy_previous: float
    energy_delta_units: float
    volume_gcal: float
    q_calculated: float
    difference: float
    percent: float | None = None
    created_at: datetime


class CalcPreviewRequest(BaseModel):
    """Запит на попередній розрахунок без збереження (для живого UI)."""

    house_id: int
    energy_current: float = Field(0, ge=0)
    energy_previous: float | None = None
    duration_hours: float = Field(0, ge=0)
    t_avg: float = 0.0


class CalcPreviewResponse(BaseModel):
    energy_delta_units: float
    volume_gcal: float
    q_calculated: float
    difference: float
    percent: float | None = None
