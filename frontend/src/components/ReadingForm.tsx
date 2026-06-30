import { useEffect, useState } from "react";
import { api } from "../api";
import type { CalcPreview, HouseDetail } from "../types";

interface Props {
  house: HouseDetail;
  onSaved: () => void;
}

const num = (v: string) => (v === "" ? 0 : Number(v.replace(",", ".")));

export default function ReadingForm({ house, onSaved }: Props) {
  const [date, setDate] = useState("");
  const [isControl, setIsControl] = useState(false);
  const [duration, setDuration] = useState("");
  const [tAvg, setTAvg] = useState("");
  const [current, setCurrent] = useState("");
  const [preview, setPreview] = useState<CalcPreview | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const previous = house.last_energy_reading;

  // Живий розрахунок при зміні полів (як перерахунок у формі Excel).
  useEffect(() => {
    if (current === "" || duration === "") {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api
      .preview({
        house_id: house.id,
        energy_current: num(current),
        duration_hours: num(duration),
        t_avg: num(tAvg),
      })
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [house.id, current, duration, tAvg]);

  async function save() {
    setError("");
    setSaving(true);
    try {
      await api.createReading({
        house_id: house.id,
        measure_date: isControl ? null : date || null,
        is_control: isControl,
        duration_hours: num(duration),
        t_avg: num(tAvg),
        energy_current: num(current),
      });
      setDate("");
      setDuration("");
      setTAvg("");
      setCurrent("");
      setPreview(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Введення показань</h2>
      <div className="meta">
        {house.code} · {house.address ?? "—"} · одиниці: <b>{house.unit}</b> · ТН:{" "}
        {house.heat_load} · попередній показник: <b>{previous}</b>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={isControl}
          onChange={(e) => setIsControl(e.target.checked)}
        />
        <span>Контрольне вимірювання (без дати)</span>
      </label>

      {!isControl && (
        <label>
          <span>Дата</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}

      <div className="row">
        <label>
          <span>Тривалість, год</span>
          <input
            inputMode="decimal"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
        <label>
          <span>t середньодобова, °C</span>
          <input inputMode="decimal" value={tAvg} onChange={(e) => setTAvg(e.target.value)} />
        </label>
      </div>

      <label>
        <span>Поточний показник обчислювача ({house.unit})</span>
        <input
          inputMode="decimal"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>

      {preview && (
        <div className="preview">
          <div>
            <span>Приріст ({house.unit})</span>
            <b>{preview.energy_delta_units}</b>
          </div>
          <div>
            <span>Обсяг ТЕ (факт), Гкал</span>
            <b>{preview.volume_gcal}</b>
          </div>
          <div>
            <span>Q розрахункове (норматив), Гкал</span>
            <b>{preview.q_calculated}</b>
          </div>
          <div>
            <span>Різниця, Гкал</span>
            <b className={preview.difference > 0 ? "pos" : "neg"}>{preview.difference}</b>
          </div>
          <div>
            <span>Відхилення, %</span>
            <b className={(preview.percent ?? 0) > 0 ? "pos" : "neg"}>
              {preview.percent ?? "—"}
            </b>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <button onClick={save} disabled={saving || current === ""}>
        {saving ? "Збереження…" : "Зберегти у архів"}
      </button>
    </div>
  );
}
