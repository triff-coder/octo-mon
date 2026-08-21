import { getJson, putJson } from "./cache";
import { fetchAgileRatesForDay, fetchHistoricalConsumption, fetchTelemetry, obtainKrakenJwt } from "./octopus";
import {
  billingPeriodKey,
  isSameBillingPeriod,
  isSameLondonDay,
  londonDateKey,
  londonMidnightUtc,
  nextBillingPeriodStartUtc,
  nextLondonMidnightUtc,
  secondsBetween,
} from "./time";
import type { AgileRate, Env, MonthAccumulator, StatusResponse, TodayAccumulator } from "./types";

const STATUS_SNAPSHOT_KV_KEY = "status:latest";
const STATUS_SNAPSHOT_TTL_SECONDS = 30 * 60;
const TODAY_ACCUMULATOR_KV_KEY = "today:accumulator";
const MONTH_ACCUMULATOR_KV_KEY = "month:accumulator";
// A cached snapshot older than this (roughly 3 missed 5-minute cron ticks)
// is flagged stale rather than presented as current.
const STALE_THRESHOLD_SECONDS = 15 * 60;

/** Finds the Agile rate whose validity window contains `instant`. */
export function findRateForInstant(rates: AgileRate[], instant: Date): AgileRate | null {
  const t = instant.getTime();
  return (
    rates.find((r) => new Date(r.validFrom).getTime() <= t && t < new Date(r.validTo).getTime()) ??
    null
  );
}

/**
 * Applies newly-fetched telemetry points to the running "today" accumulator,
 * pricing each point's consumption at the Agile rate in effect when it was
 * read. Points at or before `accumulator.lastReadingAt` are ignored so a
 * point already applied by a previous tick is never double-counted. Rolls
 * the accumulator over to a fresh day when the local calendar date changes.
 */
export function advanceTodayAccumulator(
  accumulator: TodayAccumulator | null,
  points: { readAt: string; consumptionDeltaKwh: number }[],
  ratesByDay: Map<string, AgileRate[]>,
  now: Date,
): TodayAccumulator {
  const todayKey = londonDateKey(now);

  const acc: TodayAccumulator =
    accumulator && isSameLondonDay(new Date(accumulator.lastReadingAt), now)
      ? { ...accumulator }
      : { dateKey: todayKey, kwhSoFar: 0, costGbpSoFar: 0, lastReadingAt: new Date(0).toISOString() };

  const lastAppliedMs = new Date(acc.lastReadingAt).getTime();

  for (const point of points) {
    const pointMs = new Date(point.readAt).getTime();
    if (pointMs <= lastAppliedMs) continue;

    const pointDate = new Date(point.readAt);
    const dayKey = londonDateKey(pointDate);
    const rates = ratesByDay.get(dayKey) ?? [];
    const rate = findRateForInstant(rates, pointDate);

    if (rate) {
      acc.kwhSoFar += point.consumptionDeltaKwh;
      acc.costGbpSoFar += (point.consumptionDeltaKwh * rate.pencePerKwh) / 100;
    }
    acc.lastReadingAt = point.readAt;
  }

  return acc;
}

/**
 * Same accumulation logic as advanceTodayAccumulator, but keyed to the
 * Octopus billing period (resets on the 20th of each month) rather than the
 * local calendar day.
 */
export function advanceMonthAccumulator(
  accumulator: MonthAccumulator | null,
  points: { readAt: string; consumptionDeltaKwh: number }[],
  ratesByDay: Map<string, AgileRate[]>,
  now: Date,
): MonthAccumulator {
  const periodKey = billingPeriodKey(now);

  const acc: MonthAccumulator =
    accumulator && isSameBillingPeriod(new Date(accumulator.lastReadingAt), now)
      ? { ...accumulator }
      : { periodKey, kwhSoFar: 0, costGbpSoFar: 0, lastReadingAt: new Date(0).toISOString() };

  const lastAppliedMs = new Date(acc.lastReadingAt).getTime();

  for (const point of points) {
    const pointMs = new Date(point.readAt).getTime();
    if (pointMs <= lastAppliedMs) continue;

    const pointDate = new Date(point.readAt);
    const dayKey = londonDateKey(pointDate);
    const rates = ratesByDay.get(dayKey) ?? [];
    const rate = findRateForInstant(rates, pointDate);

    if (rate) {
      acc.kwhSoFar += point.consumptionDeltaKwh;
      acc.costGbpSoFar += (point.consumptionDeltaKwh * rate.pencePerKwh) / 100;
    }
    acc.lastReadingAt = point.readAt;
  }

  return acc;
}

/**
 * Backfills a fresh MonthAccumulator's starting balance from the REST
 * consumption endpoint, covering every already-completed day between the
 * start of the current billing period and the start of today. Used only
 * when there's no usable in-period accumulator state to carry forward
 * (first run, KV loss, or a billing-period rollover) — live telemetry
 * still drives everything from today onward. Returns a zero balance
 * without any network call when the billing period started today (nothing
 * to backfill).
 */
async function backfillMonthAccumulator(env: Env, now: Date): Promise<MonthAccumulator> {
  const periodKey = billingPeriodKey(now);
  const todayKey = londonDateKey(now);
  const periodStart = londonMidnightUtc(periodKey);
  const todayStart = londonMidnightUtc(todayKey);

  if (periodStart.getTime() >= todayStart.getTime()) {
    return { periodKey, kwhSoFar: 0, costGbpSoFar: 0, lastReadingAt: todayStart.toISOString() };
  }

  const intervals = await fetchHistoricalConsumption(env, periodStart, todayStart);
  const ratesCache = new Map<string, AgileRate[]>();

  let kwhSoFar = 0;
  let costGbpSoFar = 0;

  for (const interval of intervals) {
    const intervalStart = new Date(interval.intervalStart);
    const dayKey = londonDateKey(intervalStart);

    let rates = ratesCache.get(dayKey);
    if (!rates) {
      rates = await fetchAgileRatesForDay(env, dayKey);
      ratesCache.set(dayKey, rates);
    }

    const rate = findRateForInstant(rates, intervalStart);
    if (rate) {
      kwhSoFar += interval.consumptionKwh;
      costGbpSoFar += (interval.consumptionKwh * rate.pencePerKwh) / 100;
    }
  }

  return { periodKey, kwhSoFar, costGbpSoFar, lastReadingAt: todayStart.toISOString() };
}

/**
 * Returns the month accumulator to build on for `now`: the existing one if
 * it's still within the current billing period, otherwise a fresh one
 * seeded via backfillMonthAccumulator so a period rollover (or first run)
 * doesn't silently drop already-elapsed days in the period.
 *
 * Backfilling is a best-effort enhancement, not a hard dependency of
 * /status: if the consumption endpoint fails (wrong MPAN/serial, no data
 * yet for a brand-new meter, Octopus outage, ...) this falls back to a
 * zero-balance accumulator starting today, rather than letting the whole
 * request fail.
 */
async function resolveMonthAccumulator(
  env: Env,
  previousMonthAccumulator: MonthAccumulator | null,
  now: Date,
): Promise<MonthAccumulator> {
  if (
    previousMonthAccumulator &&
    isSameBillingPeriod(new Date(previousMonthAccumulator.lastReadingAt), now)
  ) {
    return previousMonthAccumulator;
  }
  try {
    return await backfillMonthAccumulator(env, now);
  } catch (error) {
    console.error("octo-mon month backfill failed, starting this month's total from zero:", error);
    return {
      periodKey: billingPeriodKey(now),
      kwhSoFar: 0,
      costGbpSoFar: 0,
      lastReadingAt: londonMidnightUtc(londonDateKey(now)).toISOString(),
    };
  }
}

export interface ComputedStatus {
  status: StatusResponse;
  accumulator: TodayAccumulator;
  monthAccumulator: MonthAccumulator;
}

/**
 * Orchestrates a full refresh: obtains a Kraken JWT, resolves the month
 * accumulator (backfilling from history on a cold start/period rollover),
 * fetches live telemetry since the last known reading, advances the today
 * and this-month accumulators from it, and looks up the current rate/demand
 * for the response payload.
 */
export async function computeStatus(
  env: Env,
  previousAccumulator: TodayAccumulator | null,
  previousMonthAccumulator: MonthAccumulator | null,
  now: Date = new Date(),
): Promise<ComputedStatus> {
  const jwt = await obtainKrakenJwt(env, now);

  const todayKey = londonDateKey(now);
  const todayRates = await fetchAgileRatesForDay(env, todayKey);
  const ratesByDay = new Map<string, AgileRate[]>([[todayKey, todayRates]]);

  const resolvedMonthAccumulator = await resolveMonthAccumulator(env, previousMonthAccumulator, now);

  // The accumulator resets for a new day (see advanceTodayAccumulator), so
  // whenever it's reused it's always from earlier today; fetchSince is
  // therefore always within today's rates window.
  const fetchSince =
    previousAccumulator && isSameLondonDay(new Date(previousAccumulator.lastReadingAt), now)
      ? new Date(previousAccumulator.lastReadingAt)
      : londonMidnightUtc(todayKey);

  const points = await fetchTelemetry(env, jwt, fetchSince, now);
  const accumulator = advanceTodayAccumulator(previousAccumulator, points, ratesByDay, now);
  let monthAccumulator = advanceMonthAccumulator(resolvedMonthAccumulator, points, ratesByDay, now);

  // Today's usage is always a subset of the current billing period, so this
  // month's total can never legitimately be less than today's. If it ever
  // is — e.g. residual skew from a backfill that resolved after today's own
  // reset during crash recovery — self-heal (and persist the correction)
  // rather than just masking it in this one response.
  if (
    monthAccumulator.kwhSoFar < accumulator.kwhSoFar ||
    monthAccumulator.costGbpSoFar < accumulator.costGbpSoFar
  ) {
    monthAccumulator = {
      ...monthAccumulator,
      kwhSoFar: Math.max(monthAccumulator.kwhSoFar, accumulator.kwhSoFar),
      costGbpSoFar: Math.max(monthAccumulator.costGbpSoFar, accumulator.costGbpSoFar),
    };
  }

  const latestPoint = points.at(-1);
  const currentDemandKw = latestPoint?.demandKw ?? 0;
  const currentRate = findRateForInstant(todayRates, now);

  const currentCostPerHourGbp = currentRate
    ? (currentDemandKw * currentRate.pencePerKwh) / 100
    : 0;

  const status: StatusResponse = {
    generatedAt: now.toISOString(),
    currentRate: currentRate ?? { pencePerKwh: 0, validFrom: now.toISOString(), validTo: now.toISOString() },
    currentDemandKw,
    currentCostPerHourGbp,
    todayTotalKwh: accumulator.kwhSoFar,
    todayTotalCostGbp: accumulator.costGbpSoFar,
    thisMonthTotalKwh: monthAccumulator.kwhSoFar,
    thisMonthTotalCostGbp: monthAccumulator.costGbpSoFar,
    billingPeriodStart: monthAccumulator.periodKey,
    stale: false,
    snapshotAgeSeconds: 0,
  };

  return { status, accumulator, monthAccumulator };
}

/** Writes a freshly computed status + accumulators to KV. */
export async function persistComputedStatus(env: Env, computed: ComputedStatus, now: Date): Promise<void> {
  await putJson(env.OCTOMON_KV, STATUS_SNAPSHOT_KV_KEY, computed.status, {
    expirationTtl: STATUS_SNAPSHOT_TTL_SECONDS,
  });
  await putJson(env.OCTOMON_KV, TODAY_ACCUMULATOR_KV_KEY, computed.accumulator, {
    expirationTtl: Math.max(60, secondsBetween(now, nextLondonMidnightUtc(now)) + 3600),
  });
  await putJson(env.OCTOMON_KV, MONTH_ACCUMULATOR_KV_KEY, computed.monthAccumulator, {
    expirationTtl: Math.max(60, secondsBetween(now, nextBillingPeriodStartUtc(now)) + 3600),
  });
}

export async function loadTodayAccumulator(env: Env): Promise<TodayAccumulator | null> {
  return getJson<TodayAccumulator>(env.OCTOMON_KV, TODAY_ACCUMULATOR_KV_KEY);
}

export async function loadMonthAccumulator(env: Env): Promise<MonthAccumulator | null> {
  return getJson<MonthAccumulator>(env.OCTOMON_KV, MONTH_ACCUMULATOR_KV_KEY);
}

/**
 * Reads the cached status snapshot for GET /status. If it's missing or has
 * expired (the cron hasn't run recently), falls back to computing live and
 * opportunistically writes the result back to KV.
 */
export async function getOrComputeStatus(env: Env, now: Date = new Date()): Promise<StatusResponse> {
  const snapshot = await getJson<StatusResponse>(env.OCTOMON_KV, STATUS_SNAPSHOT_KV_KEY);
  if (snapshot) {
    const ageSeconds = secondsBetween(new Date(snapshot.generatedAt), now);
    return {
      ...snapshot,
      stale: ageSeconds > STALE_THRESHOLD_SECONDS,
      snapshotAgeSeconds: ageSeconds,
    };
  }

  const previousAccumulator = await loadTodayAccumulator(env);
  const previousMonthAccumulator = await loadMonthAccumulator(env);
  const computed = await computeStatus(env, previousAccumulator, previousMonthAccumulator, now);
  await persistComputedStatus(env, computed, now);
  return computed.status;
}
