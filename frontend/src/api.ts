import type { CalcPreview, House, HouseDetail, Reading } from "./types";

async function http<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Помилка ${res.status}`);
  }
  return res.json();
}

export interface ReadingInput {
  house_id: number;
  measure_date: string | null;
  is_control: boolean;
  duration_hours: number;
  t_avg: number;
  energy_current: number;
  energy_previous?: number | null;
}

export const api = {
  listHouses: () => http<House[]>("/api/houses"),
  getHouse: (id: number) => http<HouseDetail>(`/api/houses/${id}`),
  listReadings: (houseId: number) =>
    http<Reading[]>(`/api/readings?house_id=${houseId}`),
  preview: (payload: {
    house_id: number;
    energy_current: number;
    energy_previous?: number | null;
    duration_hours: number;
    t_avg: number;
  }) =>
    http<CalcPreview>("/api/readings/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createReading: (payload: ReadingInput) =>
    http<Reading>("/api/readings", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
