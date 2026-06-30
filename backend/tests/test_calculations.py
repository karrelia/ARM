"""Звірка перенесених формул з оригінальною логікою VBA."""
from app import calculations as c


def test_unit_conversion_matches_vba():
    # TB18_AfterUpdate: МВт*0.86, ГДж*0.2388, кВт*0.00086, Гкал*1
    assert c.convert_to_gcal(10, "МВт") == 8.6
    assert c.convert_to_gcal(10, "ГДж") == 2.388
    assert c.convert_to_gcal(1000, "кВт") == 0.86
    assert c.convert_to_gcal(5.5, "Гкал") == 5.5
    # Невідома одиниця -> множник 1
    assert c.convert_to_gcal(3, "???") == 3.0


def test_q_ideal_matches_vba_formula():
    # Q = (heat_load/1000) * duration * share * ((18 - t_avg)/41)
    q = c.calc_q_ideal(heat_load=86.0, duration_hours=720, share=1.0, t_avg=-5)
    expected = round((86.0 / 1000) * 720 * 1.0 * ((18 - (-5)) / 41), 3)
    assert q == expected


def test_zero_duration_gives_zero():
    assert c.calc_q_ideal(heat_load=86, duration_hours=0, t_avg=-5) == 0.0


def test_difference_and_percent():
    diff, pct = c.calc_difference(fact_gcal=10.0, q_ideal=8.0)
    assert diff == 2.0
    assert pct == 25.0


def test_percent_none_when_no_norm():
    diff, pct = c.calc_difference(fact_gcal=5.0, q_ideal=0.0)
    assert diff == 5.0
    assert pct is None


def test_compute_reading_full_cycle():
    res = c.compute_reading(
        energy_current=120.0,
        energy_previous=100.0,
        unit="МВт",
        duration_hours=720,
        t_avg=-5,
        heat_load=86.0,
        share=1.0,
    )
    assert res["energy_delta_units"] == 20.0
    assert res["volume_gcal"] == 17.2  # 20 * 0.86
    assert res["q_calculated"] == c.calc_q_ideal(86.0, 720, 1.0, -5)
    assert res["difference"] == round(17.2 - res["q_calculated"], 3)
