"""Ендпоінти довідника будинків/абонентів."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/houses", tags=["houses"])


@router.get("", response_model=list[schemas.HouseOut])
def list_houses(db: Session = Depends(get_db)):
    return db.scalars(select(models.House).order_by(models.House.code)).all()


@router.get("/{house_id}", response_model=schemas.HouseDetail)
def get_house(house_id: int, db: Session = Depends(get_db)):
    house = db.get(models.House, house_id)
    if house is None:
        raise HTTPException(status_code=404, detail="Будинок не знайдено")

    last = crud.last_reading_for_house(db, house_id)
    detail = schemas.HouseDetail.model_validate(house)
    if last is not None:
        detail.last_energy_reading = last.energy_current
        detail.last_measure_date = last.measure_date
    return detail
