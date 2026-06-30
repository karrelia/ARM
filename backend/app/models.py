"""ORM-моделі — реляційний еквівалент таблиць книги ЗБЛ.

Boiler        ← довідник "Котельні"
House         ← TabAbon (реєстр абонентів/будинків) + TabTN (теплове навантаження)
Reading       ← TabBaza (архів показань)
"""
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Boiler(Base):
    __tablename__ = "boilers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True, index=True)

    houses: Mapped[list["House"]] = relationship(back_populates="boiler")


class House(Base):
    """Будинок/абонент. Поля відповідають колонкам TabAbon + TabTN."""

    __tablename__ = "houses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String, unique=True, index=True)  # Будинок
    personal_account: Mapped[str | None] = mapped_column(String)        # Особовий
    owner: Mapped[str | None] = mapped_column(String)                   # Відповідальний власник
    address: Mapped[str | None] = mapped_column(String)                 # Адреса
    settlement: Mapped[str | None] = mapped_column(String)              # Населений пункт

    boiler_id: Mapped[int | None] = mapped_column(ForeignKey("boilers.id"))
    boiler: Mapped["Boiler"] = relationship(back_populates="houses")

    meter_no: Mapped[str | None] = mapped_column(String)               # № обчислювача
    meter_type: Mapped[str | None] = mapped_column(String)             # Тип обчислювача
    unit: Mapped[str] = mapped_column(String, default="Гкал")          # Одиниці виміру

    heat_load: Mapped[float] = mapped_column(Float, default=0.0)       # ТН, Гкал/год при -23° (TabTN)
    share: Mapped[float] = mapped_column(Float, default=1.0)           # Частка в ТН
    commercial_metering: Mapped[bool] = mapped_column(Boolean, default=True)  # Комерційний облік

    readings: Mapped[list["Reading"]] = relationship(
        back_populates="house", order_by="Reading.measure_date"
    )


class Reading(Base):
    """Одне вимірювання за період — рядок TabBaza."""

    __tablename__ = "readings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    house_id: Mapped[int] = mapped_column(ForeignKey("houses.id"), index=True)
    house: Mapped["House"] = relationship(back_populates="readings")

    measure_date: Mapped[date | None] = mapped_column(Date)            # Дата (None = контрольне)
    is_control: Mapped[bool] = mapped_column(Boolean, default=False)   # Контрольне вимірювання

    duration_hours: Mapped[float] = mapped_column(Float, default=0.0)  # Тривалість споживання, год
    t_avg: Mapped[float] = mapped_column(Float, default=0.0)           # t середньодобова, °C
    unit: Mapped[str] = mapped_column(String, default="Гкал")         # Одиниці виміру

    energy_previous: Mapped[float] = mapped_column(Float, default=0.0)  # попередні показники
    energy_current: Mapped[float] = mapped_column(Float, default=0.0)   # поточні показники
    energy_delta_units: Mapped[float] = mapped_column(Float, default=0.0)  # приріст в одиницях приладу

    volume_gcal: Mapped[float] = mapped_column(Float, default=0.0)     # Обсяг ТЕ, Гкал (факт)
    q_calculated: Mapped[float] = mapped_column(Float, default=0.0)    # Q розрахункове (норматив)
    difference: Mapped[float] = mapped_column(Float, default=0.0)      # Різниця
    percent: Mapped[float | None] = mapped_column(Float)              # %

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
