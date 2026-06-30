"""Ендпоінти введення та перегляду показань (ядро АРМ)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import calculations, crud, models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/readings", tags=["readings"])


def _resolve_previous(db: Session, house_id: int, supplied: float | None) -> float:
    """Визначити попередній показник: явно переданий або з останнього запису."""
    if supplied is not None:
        return supplied
    last = crud.last_reading_for_house(db, house_id)
    return last.energy_current if last else 0.0


@router.get("", response_model=list[schemas.ReadingOut])
def list_readings(house_id: int | None = None, db: Session = Depends(get_db)):
    stmt = select(models.Reading).order_by(
        models.Reading.measure_date.desc(), models.Reading.id.desc()
    )
    if house_id is not None:
        stmt = stmt.where(models.Reading.house_id == house_id)
    return db.scalars(stmt).all()


@router.post("/preview", response_model=schemas.CalcPreviewResponse)
def preview(req: schemas.CalcPreviewRequest, db: Session = Depends(get_db)):
    """Живий розрахунок без збереження — для форми введення."""
    house = db.get(models.House, req.house_id)
    if house is None:
        raise HTTPException(status_code=404, detail="Будинок не знайдено")

    previous = _resolve_previous(db, req.house_id, req.energy_previous)
    result = calculations.compute_reading(
        energy_current=req.energy_current,
        energy_previous=previous,
        unit=house.unit,
        duration_hours=req.duration_hours,
        t_avg=req.t_avg,
        heat_load=house.heat_load,
        share=house.share,
    )
    return schemas.CalcPreviewResponse(**result)


@router.post("", response_model=schemas.ReadingOut, status_code=201)
def create_reading(payload: schemas.ReadingCreate, db: Session = Depends(get_db)):
    house = db.get(models.House, payload.house_id)
    if house is None:
        raise HTTPException(status_code=404, detail="Будинок не знайдено")

    previous = _resolve_previous(db, payload.house_id, payload.energy_previous)
    if payload.energy_current < previous:
        raise HTTPException(
            status_code=422,
            detail=f"Поточний показник ({payload.energy_current}) менший за "
            f"попередній ({previous}).",
        )

    result = calculations.compute_reading(
        energy_current=payload.energy_current,
        energy_previous=previous,
        unit=house.unit,
        duration_hours=payload.duration_hours,
        t_avg=payload.t_avg,
        heat_load=house.heat_load,
        share=house.share,
    )

    reading = models.Reading(
        house_id=house.id,
        measure_date=None if payload.is_control else payload.measure_date,
        is_control=payload.is_control,
        duration_hours=payload.duration_hours,
        t_avg=payload.t_avg,
        unit=house.unit,
        energy_previous=previous,
        energy_current=payload.energy_current,
        **result,
    )
    db.add(reading)
    db.commit()
    db.refresh(reading)
    return reading
