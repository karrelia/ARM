import type { Reading } from "../types";

interface Props {
  readings: Reading[];
}

export default function ReadingsTable({ readings }: Props) {
  return (
    <div className="card">
      <h2>Історія показань ({readings.length})</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Трив., год</th>
              <th>t сер., °C</th>
              <th>Поточн.</th>
              <th>Приріст</th>
              <th>Факт, Гкал</th>
              <th>Норматив</th>
              <th>Різниця</th>
              <th>%</th>
            </tr>
          </thead>
          <tbody>
            {readings.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", color: "#9ca3af" }}>
                  Показань ще немає
                </td>
              </tr>
            )}
            {readings.map((r) => (
              <tr key={r.id}>
                <td>{r.is_control ? "Контрольне" : r.measure_date ?? "—"}</td>
                <td>{r.duration_hours}</td>
                <td>{r.t_avg}</td>
                <td>{r.energy_current}</td>
                <td>{r.energy_delta_units}</td>
                <td>{r.volume_gcal}</td>
                <td>{r.q_calculated}</td>
                <td className={r.difference > 0 ? "pos" : "neg"}>{r.difference}</td>
                <td className={(r.percent ?? 0) > 0 ? "pos" : "neg"}>{r.percent ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
