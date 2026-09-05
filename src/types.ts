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

/** A single published unit rate for a validity window (from Octopus's standard-unit-rates endpoint — any tariff, not just Agile). */
export interface UnitRate {
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
  /**
   * Cost recorded against each Europe/London calendar date in this billing
   * period that has any data at all, keyed YYYY-MM-DD. Maintained purely
   * from what this Worker has actually accumulated — never re-derived from
   * Octopus — so it stays accurate for the whole period even when the REST
   * consumption endpoint is unavailable, and long after the ~8-day hour
   * buckets have aged out.
   *
   * Days missing from this map are days the Worker genuinely has no data
   * for (e.g. it wasn't running yet, or the meter hadn't been provisioned),
   * as opposed to days that cost £0 — which is exactly what
   * predictMonthCostGbp needs in order to fill them in at the average rate
   * rather than silently counting them as free.
   */
  dailyCostsGbp: Record<string, number>;
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
  /** Today's consumption cost so far, plus a full day's standing charge (see fetchStandingChargeForDay) — the standing charge accrues once per calendar day regardless of usage, so it's added in full rather than prorated by how much of the day has elapsed. */
  todayTotalCostGbp: number;
  /**
   * Total spend for the previous Europe/London calendar day, derived by
   * summing `hourlyBuckets`' underlying per-hour totals for that date
   * (not a separately-tracked accumulator) — so, like the chart, it fills
   * in gradually and undercounts any hour with a telemetry gap rather than
   * failing outright. Consumption cost only — unlike `todayTotalCostGbp`,
   * this does not include a standing charge.
   */
  yesterdayTotalKwh: number;
  yesterdayTotalCostGbp: number;
  thisMonthTotalKwh: number;
  /** This billing period's consumption cost so far, plus the standing charge for every elapsed day of the period (today's rate assumed for the whole period — see computeStatus). */
  thisMonthTotalCostGbp: number;
  billingPeriodStart: string;
  /** Set when the month backfill was attempted and failed (falling back to a zero-balance start), null otherwise. */
  monthBackfillError: string | null;
  /** Europe/London date of the earliest day this billing period has any recorded data for, derived from MonthAccumulator.dailyCostsGbp. Days before it are estimated at the daily average — see predictMonthCostGbp. */
  firstDataDateKey: string;
  /** How many days of this billing period have complete recorded data behind predictedMonthCostGbp's daily average (excludes today and the first, usually partial, day). */
  completeDataDayCount: number;
  /** Cost of the most recently completed UTC clock hour (not the current in-progress one). Consumption cost only — never includes the standing charge. */
  lastHourCostGbp: number;
  /** kWh consumed in that same most recently completed UTC clock hour. */
  lastHourKwh: number;
  /**
   * The last 24 complete UTC clock hours, oldest first. Built purely from
   * live telemetry (no backfill), so it fills in gradually over the first
   * 24 hours after this feature first runs — hours before that show £0.00
   * rather than missing data. `weeklyAvgCostGbp` is the average cost of
   * that same hour-of-day over the preceding up-to-7 days (0 until enough
   * history has accumulated), for an at-a-glance "vs. usual" comparison.
   * Consumption cost only — never includes the standing charge.
   */
  hourlyBuckets: { hourStart: string; costGbp: number; kwh: number; weeklyAvgCostGbp: number }[];
  /**
   * Predicted total cost for today (Europe/London calendar day): today's
   * actual cost so far plus, for each hour of today still to come, that
   * hour-of-day's average cost over up to the preceding 7 days — plus
   * today's standing charge (already accrued in full, not prorated).
   */
  predictedTodayCostGbp: number;
  /**
   * Predicted total cost for the current Octopus billing period: the
   * consumption estimate (extrapolating the average daily cost so far,
   * including today, across the whole period) plus the standing charge for
   * every day of the period, elapsed and still to come, at today's rate.
   */
  predictedMonthCostGbp: number;
  /**
   * Upcoming "smart charging" dispatch slots (e.g. Intelligent Octopus Go's
   * occasional off-schedule "bump charge" boosts), earliest first, chopped
   * into 30-minute windows priced at today's off-peak rate. This is *not*
   * the everyday scheduled off-peak window — it's only the occasional extra
   * ones Octopus grants outside/beyond it — so it's empty most of the time,
   * not just shorter near the end of the day. Also empty on a tariff/account
   * with no dispatch mechanism at all.
   */
  nextAgileSlots: UnitRate[];
  stale: boolean;
  snapshotAgeSeconds: number;
}

/** A single day's total in DailyHistoryResponse. */
export interface DailyHistoryEntry {
  /** Europe/London calendar date (YYYY-MM-DD). */
  dateKey: string;
  kwh: number;
  costGbp: number;
}

/**
 * The JSON payload served from GET /history — used by the dashboard's
 * "LAST 30 DAYS" list and the large Scriptable widget's daily-history
 * chart. Small/medium widgets don't call this endpoint.
 */
export interface DailyHistoryResponse {
  /**
   * Up to the last 30 complete Europe/London calendar days, oldest first
   * (today is never included — always in progress). Only days with actual
   * consumption data are included, so this can be shorter than 30 entries
   * (e.g. a newly set up account) rather than padded with zero-value days.
   */
  days: DailyHistoryEntry[];
  generatedAt: string;
}
