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

/** A single historical half-hourly consumption interval from the REST API. */
export interface ConsumptionInterval {
  consumptionKwh: number;
  intervalStart: string;
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

/**
 * The running "this billing month so far" accumulator stored in KV. Resets
 * on the Octopus billing cycle boundary (the 20th of each month) rather
 * than at local midnight.
 */
export interface MonthAccumulator {
  periodKey: string;
  kwhSoFar: number;
  costGbpSoFar: number;
  lastReadingAt: string;
}

/** Running totals for a single UTC clock hour, part of HourBucketsState. */
export interface HourBucket {
  /** ISO instant at the start of this UTC clock hour. */
  hourStart: string;
  kwhSoFar: number;
  costGbpSoFar: number;
}

/**
 * Rolling per-hour totals stored in KV, covering roughly the last 25 hours
 * (trimmed each tick). Unlike the today/month accumulators this never
 * "resets" — old buckets just age out — so the widget can chart the last 24
 * complete hours.
 */
export interface HourBucketsState {
  buckets: HourBucket[];
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
  thisMonthTotalKwh: number;
  thisMonthTotalCostGbp: number;
  billingPeriodStart: string;
  /** Set when the month backfill was attempted and failed (falling back to a zero-balance start), null otherwise. */
  monthBackfillError: string | null;
  /** Cost of the most recently completed UTC clock hour (not the current in-progress one). */
  lastHourCostGbp: number;
  /**
   * The last 24 complete UTC clock hours, oldest first. Built purely from
   * live telemetry (no backfill), so it fills in gradually over the first
   * 24 hours after this feature first runs — hours before that show £0.00
   * rather than missing data. `weeklyAvgCostGbp` is the average cost of
   * that same hour-of-day over the preceding up-to-7 days (0 until enough
   * history has accumulated), for an at-a-glance "vs. usual" comparison.
   */
  hourlyBuckets: { hourStart: string; costGbp: number; weeklyAvgCostGbp: number }[];
  stale: boolean;
  snapshotAgeSeconds: number;
}
