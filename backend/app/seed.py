"""Демо-наповнення БД, щоб прототип одразу мав з чим працювати.

Дані наближені до реального довідника книги ЗБЛ (котельні Полтава/Миргород,
будинки по вул. Олександра Оксанченка). Реальні дані можна завантажити окремо
скриптом import_xlsm.py.
"""
from .database import Base, SessionLocal, engine
from . import models


DEMO_BOILERS = ["П517", "Миргород-1", "Полтава-Центр"]

# (code, owner, address, settlement, unit, heat_load, meter_type, boiler_idx)
DEMO_HOUSES = [
    ("БАГАЧАНСЬКА104", "ОСББ Багачанська 104", "вул.Олександра Оксанченка, 104",
     "Полтава", "МВт", 86.0, "Kamstrup Multical 602", 0),
    ("БАГАЧАНСЬКА110", "ОСББ Багачанська 110", "вул.Олександра Оксанченка, 110",
     "Полтава", "МВт", 92.0, "Kamstrup Multical 602", 0),
    ("ОКСАНЧЕНКА58", "ОСББ Оксанченка 58", "вул.Олександра Оксанченка, 58",
     "Полтава", "Гкал", 0.118, "Kamstrup Multical 602", 0),
    ("ОКСАНЧЕНКА60", "ОСББ Оксанченка 60", "вул.Олександра Оксанченка, 60",
     "Полтава", "ГДж", 360.0, "Sensus PolluTherm", 2),
    ("МИРГОРОД-ГОГОЛЯ12", "ОСББ Гоголя 12", "вул.Гоголя, 12",
     "Миргород", "Гкал", 0.205, "Kamstrup Multical 602", 1),
]


def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(models.House).count() > 0:
            print("БД вже наповнена — пропускаю seed.")
            return

        boilers = []
        for name in DEMO_BOILERS:
            b = models.Boiler(name=name)
            db.add(b)
            boilers.append(b)
        db.flush()

        for i, (code, owner, addr, settlement, unit, load, mtype, bidx) in enumerate(
            DEMO_HOUSES, start=1
        ):
            db.add(
                models.House(
                    code=code,
                    personal_account=f"{1000 + i}",
                    owner=owner,
                    address=addr,
                    settlement=settlement,
                    boiler_id=boilers[bidx].id,
                    meter_no=f"M{600000 + i}",
                    meter_type=mtype,
                    unit=unit,
                    heat_load=load,
                    share=1.0,
                    commercial_metering=True,
                )
            )
        db.commit()
        print(f"Створено {len(boilers)} котелень та {len(DEMO_HOUSES)} будинків.")
    finally:
        db.close()


if __name__ == "__main__":
    seed()
