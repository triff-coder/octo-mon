export interface Env {
  OCTOMON_KV: KVNamespace;

  OCTOPUS_PRODUCT_CODE: string;
  OCTOPUS_TARIFF_CODE: string;

  OCTOPUS_API_KEY: string;
  OCTOPUS_ACCOUNT_NUMBER: string;
  OCTOPUS_MPAN: string;
  OCTOPUS_METER_SERIAL: string;
  OCTOPUS_DEVICE_ID: string;
  WIDGET_SHARED_SECRET: string;
}

/** A single published Agile half-hourly unit rate. */
export interface AgileRate {
  pencePerKwh: number;
  validFrom: string;
  validTo: string;
}

/** The Kraken JWT cached in KV between requests. */
export interface KrakenJwtCache {
  token: string;
  expiresAt: string;
}

/** A single live smart-meter telemetry point from the Home Mini. */
export interface TelemetryPoint {
  readAt: string;
  demandKw: number;
  /** Energy consumed since the previous telemetry point, in kWh. */
  consumptionDeltaKwh: number;
}

/** The running "today so far" accumulator stored in KV. */
export interface TodayAccumulator {
  dateKey: string;
  kwhSoFar: number;
  costGbpSoFar: number;
  lastReadingAt: string;
}

/** The JSON payload served from GET /status. */
export interface StatusResponse {
  generatedAt: string;
  currentRate: {
    pencePerKwh: number;
    validFrom: string;
    validTo: string;
  };
  currentDemandKw: number;
  currentCostPerHourGbp: number;
  todayTotalKwh: number;
  todayTotalCostGbp: number;
  stale: boolean;
  snapshotAgeSeconds: number;
}
