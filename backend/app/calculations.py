"""Ядро розрахунків — перенесене 1:1 з VBA-коду книги ЗБЛ.

Тут зосереджена вся бізнес-логіка, яка в Excel була "розмазана" по
обробниках UserForm1 (CommandButton2_Click, TB18_AfterUpdate) та модулях.
Винесення в один модуль дозволяє покрити її тестами й перевикористати в API.
"""
from __future__ import annotations

# --- Константи нормативного розрахунку (з UserForm1) ---

# Коефіцієнти переведення приладових одиниць у Гкал (TB18_AfterUpdate)
UNIT_TO_GCAL: dict[str, float] = {
    "Гкал": 1.0,
    "МВт": 0.86,
    "ГДж": 0.2388,
    "кВт": 0.00086,
}

# Розрахункова внутрішня температура, °C (TBpr за замовчуванням = 18)
T_INDOOR_DEFAULT = 18.0

# Розрахункова різниця температур: t_внутр - t_зовн.розрах = 18 - (-23) = 41
DESIGN_TEMP_DIFF = 41.0


def convert_to_gcal(delta_units: float, unit: str) -> float:
    """Перевести приріст показань приладу в Гкал.

    Відповідає блоку TB18_AfterUpdate: множення приросту на коефіцієнт одиниці.
    """
    factor = UNIT_TO_GCAL.get(unit, 1.0)
    return round(delta_units * factor, 3)


def calc_q_ideal(
    heat_load: float,
    duration_hours: float,
    share: float = 1.0,
    t_avg: float = 0.0,
    t_indoor: float = T_INDOOR_DEFAULT,
) -> float:
    """Нормативна ("ідеальна") кількість теплової енергії, Гкал.

    Формула з UserForm1.CommandButton2_Click:

        Q = (heat_load / 1000) * duration * share * ((t_indoor - t_avg) / 41)

    де:
      heat_load     — розрахункове теплове навантаження будинку (TabTN),
                      Гкал/год при -23° (масштаб /1000 збережено як в оригіналі);
      duration_hours— тривалість споживання теплоти за період, год;
      share         — частка будинку в тепловому навантаженні (Частка в ТН);
      t_avg         — середньодобова температура зовнішнього повітря, °C;
      t_indoor      — розрахункова внутрішня температура (18 °C).
    """
    if not duration_hours:
        return 0.0
    q = (heat_load / 1000.0) * duration_hours * share * ((t_indoor - t_avg) / DESIGN_TEMP_DIFF)
    return round(q, 3)


def calc_difference(fact_gcal: float, q_ideal: float) -> tuple[float, float | None]:
    """Різниця факт - норматив (Гкал) і відсоток відхилення.

    Відповідає TBd / TBp у CommandButton2_Click.
    Повертає (різниця, відсоток). Відсоток = None, якщо норматив = 0.
    """
    diff = round(fact_gcal - q_ideal, 3)
    pct = round((diff / q_ideal) * 100, 2) if q_ideal else None
    return diff, pct


def compute_reading(
    *,
    energy_current: float,
    energy_previous: float,
    unit: str,
    duration_hours: float,
    t_avg: float,
    heat_load: float,
    share: float = 1.0,
    t_indoor: float = T_INDOOR_DEFAULT,
) -> dict:
    """Повний розрахунок одного вимірювання (як натискання кнопки "Розрахунок").

    Об'єднує конвертацію приросту, нормативний розрахунок і відхилення в один
    результат, який зберігається у таблицю показань.
    """
    delta_units = round(energy_current - energy_previous, 3)
    volume_gcal = convert_to_gcal(delta_units, unit)
    q_ideal = calc_q_ideal(
        heat_load=heat_load,
        duration_hours=duration_hours,
        share=share,
        t_avg=t_avg,
        t_indoor=t_indoor,
    )
    diff, pct = calc_difference(volume_gcal, q_ideal)
    return {
        "energy_delta_units": delta_units,
        "volume_gcal": volume_gcal,
        "q_calculated": q_ideal,
        "difference": diff,
        "percent": pct,
    }
