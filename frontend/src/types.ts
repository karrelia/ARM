export interface House {
  id: number;
  code: string;
  personal_account: string | null;
  owner: string | null;
  address: string | null;
  settlement: string | null;
  boiler_id: number | null;
  meter_no: string | null;
  meter_type: string | null;
  unit: string;
  heat_load: number;
  share: number;
  commercial_metering: boolean;
}

export interface HouseDetail extends House {
  last_energy_reading: number;
  last_measure_date: string | null;
}

export interface CalcPreview {
  energy_delta_units: number;
  volume_gcal: number;
  q_calculated: number;
  difference: number;
  percent: number | null;
}

export interface Reading extends CalcPreview {
  id: number;
  house_id: number;
  measure_date: string | null;
  is_control: boolean;
  duration_hours: number;
  t_avg: number;
  unit: string;
  energy_previous: number;
  energy_current: number;
  created_at: string;
}
