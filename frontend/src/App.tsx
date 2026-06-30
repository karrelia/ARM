import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { House, HouseDetail, Reading } from "./types";
import ReadingForm from "./components/ReadingForm";
import ReadingsTable from "./components/ReadingsTable";

export default function App() {
  const [houses, setHouses] = useState<House[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [house, setHouse] = useState<HouseDetail | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);

  useEffect(() => {
    api.listHouses().then((hs) => {
      setHouses(hs);
      if (hs.length) setSelectedId(hs[0].id);
    });
  }, []);

  const loadHouse = useCallback((id: number) => {
    api.getHouse(id).then(setHouse);
    api.listReadings(id).then(setReadings);
  }, []);

  useEffect(() => {
    if (selectedId != null) loadHouse(selectedId);
  }, [selectedId, loadHouse]);

  return (
    <>
      <header>
        <h1>АРМ Теплооблік</h1>
        <span>Облік відпущеної теплової енергії по будинках · прототип MVP</span>
      </header>
      <main>
        <div style={{ display: "grid", gap: 20 }}>
          <div className="card">
            <h2>Будинок / абонент</h2>
            <select
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(Number(e.target.value))}
            >
              {houses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.code} — {h.address ?? ""}
                </option>
              ))}
            </select>
          </div>
          {house && (
            <ReadingForm
              house={house}
              onSaved={() => selectedId != null && loadHouse(selectedId)}
            />
          )}
        </div>
        <ReadingsTable readings={readings} />
      </main>
    </>
  );
}
