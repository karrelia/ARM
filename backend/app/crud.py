"""Допоміжні операції доступу до даних."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models


def last_reading_for_house(db: Session, house_id: int) -> models.Reading | None:
    """Останнє за датою показання будинку — джерело "попередніх показників".

    Контрольні вимірювання (без дати) ігноруються при пошуку попереднього
    показника лічильника, так само як у логіці FillTB.
    """
    stmt = (
        select(models.Reading)
        .where(models.Reading.house_id == house_id)
        .where(models.Reading.is_control.is_(False))
        .order_by(models.Reading.measure_date.desc(), models.Reading.id.desc())
        .limit(1)
    )
    return db.scalars(stmt).first()
