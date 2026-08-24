import { getJson, putJson } from "./cache";
import {
  fetchHistoricalConsumption,
  fetchPlannedDispatches,
  fetchTelemetry,
  fetchUnitRatesForDay,
  obtainKrakenJwt,
  OctopusConsumptionError,
} from "./octopus";
import type { DispatchWindow } from "./octopus";
import {
  addDaysToDateKey,
  billingPeriodKey,
  hourStartUtc,
  isSameBillingPeriod,
  isSameLondonDay,
  londonDateKey,
  londonMidnightUtc,
  nextBillingPeriodStartUtc,
  nextLondonMidnightUtc,
  secondsBetween,
} from "./time";
import type {
  ConsumptionInterval,
  DailyHistoryEntry,
  DailyHistoryResponse,
  Env,
  HourBucketsState,
  MonthAccumulator,
  StatusResponse,
  TodayAccumulator,
  UnitRate,
} from "./types";

const STATUS_SNAPSHOT_KV_KEY = "status:latest";
const STATUS_SNAPSHOT_TTL_SECONDS = 30 * 60;
const TODAY_ACCUMULATOR_KV_KEY = "today:accumulator";
const MONTH_ACCUMULATOR_KV_KEY = "month:accumulator";
const HOUR_BUCKETS_KV_KEY = "hours:buckets";
// Retention needs to reach back far enough to compute a 7-day trailing
// average for the *oldest* of the 24 charted hours (24h window + 7 * 24h of
// history for that hour-of-day), plus a small buffer for the fact `now`
// isn't exactly on an hour boundary.
const HOUR_BUCKET_RETENTION_HOURS = 24 + 7 * 24 + 1;
const HOUR_BUCKETS_TTL_SECONDS = (HOUR_BUCKET_RETENTION_HOURS + 6) * 60 * 60;
// A cached snapshot older than this (roughly 3 missed 5-minute cron ticks)
// is flagged stale rather than presented as current.
const STALE_THRESHOLD_SECONDS = 15 * 60;
// 3 hours' worth of half-hourly slots — enough for both the widget's and
// dashboard's "NEXT AGILE" lists to slice down to whatever they can fit.
const UPCOMING_RATE_COUNT = 6;
// Widest telemetry window a cold start will ever request — comfortably
// under the point where Kraken's smartMeterTelemetry silently starts
// returning nothing (see the fetchSince comment in computeStatus).
const MAX_TELEMETRY_FETCH_HOURS = 6;
const DAILY_HISTORY_KV_KEY = "history:daily";
// This settles slowly (consumption REST data lags) and never changes for
// days that are already fully in the past, so there's no benefit to
// refreshing it anywhere near as often as /status — cache-or-recompute on
// a long TTL, same pattern as fetchUnitRatesForDay's per-day rate cache.
const DAILY_HISTORY_TTL_SECONDS = 12 * 60 * 60;
const DAILY_HISTORY_DAYS = 30;

/** Finds the unit rate whose validity window contains `instant`. */
export function findRateForInstant(rates: UnitRate[], instant: Date): UnitRate | null {
  const t = instant.getTime();
  return (
    rates.find((r) => new Date(r.validFrom).getTime() <= t && t < new Date(r.validTo).getTime()) ??
    null
  );
}

/**
 * Applies newly-fetched telemetry points to the running "today" accumulator,
 * pricing each point's consumption at the unit rate in effect when it was
 * read. Points at or before `accumulator.lastReadingAt` are ignored so a
 * point already applied by a previous tick is never double-counted. Rolls
 * the accumulator over to a fresh day when the local calendar date changes.
 */
export function advanceTodayAccumulator(
  accumulator: TodayAccumulator | null,
  points: { readAt: string; consumptionDeltaKwh: number }[],
  ratesByDay: Map<string, UnitRate[]>,
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
  ratesByDay: Map<string, UnitRate[]>,
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
 * Applies newly-fetched telemetry points to rolling per-UTC-hour buckets,
 * pricing each point the same way as the today/month accumulators. Unlike
 * those, this never resets — a point's hour bucket is created on demand and
 * buckets simply age out (see HOUR_BUCKET_RETENTION_HOURS) once they're
 * older than the widget's 24-hour chart window needs.
 */
export function advanceHourBuckets(
  state: HourBucketsState | null,
  points: { readAt: string; consumptionDeltaKwh: number }[],
  ratesByDay: Map<string, UnitRate[]>,
  now: Date,
): HourBucketsState {
  const st: HourBucketsState = state
    ? { buckets: state.buckets.map((b) => ({ ...b })), lastReadingAt: state.lastReadingAt }
    : { buckets: [], lastReadingAt: new Date(0).toISOString() };

  const lastAppliedMs = new Date(st.lastReadingAt).getTime();

  for (const point of points) {
    const pointMs = new Date(point.readAt).getTime();
    if (pointMs <= lastAppliedMs) continue;

    const pointDate = new Date(point.readAt);
    const dayKey = londonDateKey(pointDate);
    const rates = ratesByDay.get(dayKey) ?? [];
    const rate = findRateForInstant(rates, pointDate);

    if (rate) {
      const bucketStart = hourStartUtc(pointDate).toISOString();
      let bucket = st.buckets.find((b) => b.hourStart === bucketStart);
      if (!bucket) {
        bucket = { hourStart: bucketStart, kwhSoFar: 0, costGbpSoFar: 0 };
        st.buckets.push(bucket);
      }
      bucket.kwhSoFar += point.consumptionDeltaKwh;
      bucket.costGbpSoFar += (point.consumptionDeltaKwh * rate.pencePerKwh) / 100;
    }
    st.lastReadingAt = point.readAt;
  }

  const cutoffMs = now.getTime() - HOUR_BUCKET_RETENTION_HOURS * 3_600_000;
  st.buckets = st.buckets
    .filter((b) => new Date(b.hourStart).getTime() >= cutoffMs)
    .sort((a, b) => a.hourStart.localeCompare(b.hourStart));

  return st;
}

const WEEKLY_AVERAGE_SAMPLE_DAYS = 7;

/**
 * Normalizes hour-bucket state into exactly 24 entries, oldest first,
 * covering the last 24 *complete* UTC clock hours (never the current
 * in-progress hour, which would otherwise render as a misleadingly short
 * bar). Hours with no bucket yet (e.g. before this feature started
 * accumulating, or a gap) report £0.00 rather than being omitted, so the
 * chart always has exactly 24 bars.
 *
 * Each entry also carries `kwh` (energy consumed that hour) and
 * `weeklyAvgCostGbp`: the average cost of that same hour-of-day (e.g.
 * "14:00 UTC") over up to the preceding 7 days, averaged over however many
 * of those days actually have data (0 if none yet) — lets the widget plot
 * "this hour vs. what this hour usually costs".
 */
export function buildHourlyBuckets(
  state: HourBucketsState,
  now: Date,
): { hourStart: string; costGbp: number; kwh: number; weeklyAvgCostGbp: number }[] {
  const currentHourStartMs = hourStartUtc(now).getTime();
  const bucketByStart = new Map(state.buckets.map((b) => [b.hourStart, b]));
  const result: { hourStart: string; costGbp: number; kwh: number; weeklyAvgCostGbp: number }[] = [];

  for (let i = 24; i >= 1; i--) {
    const hourStartMs = currentHourStartMs - i * 3_600_000;
    const hourStartIso = new Date(hourStartMs).toISOString();
    const bucket = bucketByStart.get(hourStartIso);

    let weeklySum = 0;
    let weeklyCount = 0;
    for (let day = 1; day <= WEEKLY_AVERAGE_SAMPLE_DAYS; day++) {
      const pastBucket = bucketByStart.get(new Date(hourStartMs - day * 24 * 3_600_000).toISOString());
      if (pastBucket) {
        weeklySum += pastBucket.costGbpSoFar;
        weeklyCount += 1;
      }
    }

    result.push({
      hourStart: hourStartIso,
      costGbp: bucket?.costGbpSoFar ?? 0,
      kwh: bucket?.kwhSoFar ?? 0,
      weeklyAvgCostGbp: weeklyCount > 0 ? weeklySum / weeklyCount : 0,
    });
  }

  return result;
}

/**
 * Sums the hour-bucket totals for a given Europe/London calendar date
 * (e.g. "yesterday") — a derived total, not a separately-tracked
 * accumulator, so it inherits the same gradual-fill-in and gap-undercounts
 * behavior as the 24-hour chart rather than being backfilled from history.
 */
function sumHourBucketsForLondonDate(
  state: HourBucketsState,
  dateKey: string,
): { kwhSoFar: number; costGbpSoFar: number } {
  let kwhSoFar = 0;
  let costGbpSoFar = 0;
  for (const bucket of state.buckets) {
    if (londonDateKey(new Date(bucket.hourStart)) === dateKey) {
      kwhSoFar += bucket.kwhSoFar;
      costGbpSoFar += bucket.costGbpSoFar;
    }
  }
  return { kwhSoFar, costGbpSoFar };
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
  const ratesCache = new Map<string, UnitRate[]>();

  let kwhSoFar = 0;
  let costGbpSoFar = 0;

  for (const interval of intervals) {
    const intervalStart = new Date(interval.intervalStart);
    const dayKey = londonDateKey(intervalStart);

    let rates = ratesCache.get(dayKey);
    if (!rates) {
      rates = await fetchUnitRatesForDay(env, dayKey);
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

interface ResolvedMonthAccumulator {
  accumulator: MonthAccumulator;
  /** Set when backfill was attempted and failed, so the cause is visible in /status rather than only in logs. */
  backfillError: string | null;
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
 * request fail. The failure reason is still reported back (see
 * backfillError) so it's diagnosable without dashboard log access.
 */
async function resolveMonthAccumulator(
  env: Env,
  previousMonthAccumulator: MonthAccumulator | null,
  now: Date,
): Promise<ResolvedMonthAccumulator> {
  if (
    previousMonthAccumulator &&
    isSameBillingPeriod(new Date(previousMonthAccumulator.lastReadingAt), now)
  ) {
    return { accumulator: previousMonthAccumulator, backfillError: null };
  }
  try {
    const accumulator = await backfillMonthAccumulator(env, now);
    return { accumulator, backfillError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("octo-mon month backfill failed, starting this month's total from zero:", error);
    return {
      accumulator: {
        periodKey: billingPeriodKey(now),
        kwhSoFar: 0,
        costGbpSoFar: 0,
        lastReadingAt: londonMidnightUtc(londonDateKey(now)).toISOString(),
      },
      backfillError: message,
    };
  }
}

/**
 * The next few upcoming "smart charging" dispatch slots, earliest first,
 * chopped into 30-minute display windows and priced at the tariff's
 * off-peak rate (the cheapest rate published today). These are the
 * *occasional* windows Octopus grants outside (or extending) a tariff's
 * normal off-peak schedule — e.g. Intelligent Octopus Go's "bump charge"
 * boosts — not the everyday scheduled off-peak window itself, so this is
 * empty most of the time rather than always showing something. An account
 * without any dispatches configured (or a fetch failure) also just
 * produces an empty list rather than failing the whole request.
 */
async function resolveNextAgileSlots(
  env: Env,
  jwt: string,
  todayRates: UnitRate[],
  now: Date,
): Promise<UnitRate[]> {
  let dispatches: DispatchWindow[];
  try {
    dispatches = await fetchPlannedDispatches(env, jwt);
  } catch {
    return [];
  }
  if (dispatches.length === 0 || todayRates.length === 0) return [];

  const offPeakRate = Math.min(...todayRates.map((r) => r.pencePerKwh));
  const nowMs = now.getTime();

  const slots: UnitRate[] = [];
  for (const dispatch of dispatches) {
    if (slots.length >= UPCOMING_RATE_COUNT) break;

    const dispatchEndMs = new Date(dispatch.end).getTime();
    if (dispatchEndMs <= nowMs) continue; // already finished

    let slotStartMs = Math.max(new Date(dispatch.start).getTime(), nowMs);
    while (slotStartMs < dispatchEndMs && slots.length < UPCOMING_RATE_COUNT) {
      const slotEndMs = Math.min(slotStartMs + 30 * 60_000, dispatchEndMs);
      slots.push({
        pencePerKwh: offPeakRate,
        validFrom: new Date(slotStartMs).toISOString(),
        validTo: new Date(slotEndMs).toISOString(),
      });
      slotStartMs = slotEndMs;
    }
  }

  return slots;
}

export interface ComputedStatus {
  status: StatusResponse;
  accumulator: TodayAccumulator;
  monthAccumulator: MonthAccumulator;
  hourBuckets: HourBucketsState;
}

/**
 * Orchestrates a full refresh: obtains a Kraken JWT, resolves the month
 * accumulator (backfilling from history on a cold start/period rollover),
 * fetches live telemetry since the last known reading, advances the today,
 * this-month, and rolling hour-bucket accumulators from it, and looks up
 * the current rate/demand for the response payload.
 */
export async function computeStatus(
  env: Env,
  previousAccumulator: TodayAccumulator | null,
  previousMonthAccumulator: MonthAccumulator | null,
  previousHourBuckets: HourBucketsState | null,
  now: Date = new Date(),
): Promise<ComputedStatus> {
  const jwt = await obtainKrakenJwt(env, now);

  const todayKey = londonDateKey(now);
  const todayRates = await fetchUnitRatesForDay(env, todayKey);
  const ratesByDay = new Map<string, UnitRate[]>([[todayKey, todayRates]]);

  const { accumulator: resolvedMonthAccumulator, backfillError } = await resolveMonthAccumulator(
    env,
    previousMonthAccumulator,
    now,
  );

  // The accumulator resets for a new day (see advanceTodayAccumulator), so
  // whenever it's reused it's always from earlier today; fetchSince is
  // therefore always within today's rates window.
  //
  // On a cold start (no accumulator — first deploy, a KV reset, crash
  // recovery), falling back to "since local midnight" is unsafe: Kraken's
  // smartMeterTelemetry silently returns zero results (no error) once a
  // TEN_SECONDS-grouped window gets too wide — empirically somewhere north
  // of ~16 hours' worth of readings. That leaves the accumulator's
  // lastReadingAt stuck, so every later tick repeats the same too-wide
  // query forever, showing £0 indefinitely instead of just today's total
  // under-reporting (today's total already isn't backfilled on a cold
  // start regardless — see the README — so bounding this window only
  // changes how far back a fresh start reaches, not what it reconstructs).
  const cappedMidnightFallback = new Date(
    Math.max(londonMidnightUtc(todayKey).getTime(), now.getTime() - MAX_TELEMETRY_FETCH_HOURS * 3_600_000),
  );
  const fetchSince =
    previousAccumulator && isSameLondonDay(new Date(previousAccumulator.lastReadingAt), now)
      ? new Date(previousAccumulator.lastReadingAt)
      : cappedMidnightFallback;

  const points = await fetchTelemetry(env, jwt, fetchSince, now);
  const accumulator = advanceTodayAccumulator(previousAccumulator, points, ratesByDay, now);
  let monthAccumulator = advanceMonthAccumulator(resolvedMonthAccumulator, points, ratesByDay, now);
  const hourBuckets = advanceHourBuckets(previousHourBuckets, points, ratesByDay, now);

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

  const hourlyBuckets = buildHourlyBuckets(hourBuckets, now);
  const lastHourCostGbp = hourlyBuckets.at(-1)?.costGbp ?? 0;
  const lastHourKwh = hourlyBuckets.at(-1)?.kwh ?? 0;
  const nextAgileSlots = await resolveNextAgileSlots(env, jwt, todayRates, now);
  const yesterdayTotal = sumHourBucketsForLondonDate(hourBuckets, addDaysToDateKey(todayKey, -1));

  const status: StatusResponse = {
    generatedAt: now.toISOString(),
    currentRate: currentRate ?? { pencePerKwh: 0, validFrom: now.toISOString(), validTo: now.toISOString() },
    currentDemandKw,
    currentCostPerHourGbp,
    todayTotalKwh: accumulator.kwhSoFar,
    todayTotalCostGbp: accumulator.costGbpSoFar,
    yesterdayTotalKwh: yesterdayTotal.kwhSoFar,
    yesterdayTotalCostGbp: yesterdayTotal.costGbpSoFar,
    thisMonthTotalKwh: monthAccumulator.kwhSoFar,
    thisMonthTotalCostGbp: monthAccumulator.costGbpSoFar,
    billingPeriodStart: monthAccumulator.periodKey,
    monthBackfillError: backfillError,
    lastHourCostGbp,
    lastHourKwh,
    hourlyBuckets,
    nextAgileSlots,
    stale: false,
    snapshotAgeSeconds: 0,
  };

  return { status, accumulator, monthAccumulator, hourBuckets };
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
  await putJson(env.OCTOMON_KV, HOUR_BUCKETS_KV_KEY, computed.hourBuckets, {
    expirationTtl: HOUR_BUCKETS_TTL_SECONDS,
  });
}

export async function loadTodayAccumulator(env: Env): Promise<TodayAccumulator | null> {
  return getJson<TodayAccumulator>(env.OCTOMON_KV, TODAY_ACCUMULATOR_KV_KEY);
}

export async function loadMonthAccumulator(env: Env): Promise<MonthAccumulator | null> {
  return getJson<MonthAccumulator>(env.OCTOMON_KV, MONTH_ACCUMULATOR_KV_KEY);
}

export async function loadHourBuckets(env: Env): Promise<HourBucketsState | null> {
  return getJson<HourBucketsState>(env.OCTOMON_KV, HOUR_BUCKETS_KV_KEY);
}

/**
 * Computes a fresh status live (same path the cron takes) and persists it,
 * so it also becomes the new snapshot for the widget's/dashboard's next
 * cache-hit read rather than being thrown away after this one request.
 */
async function refreshStatus(env: Env, now: Date): Promise<StatusResponse> {
  const previousAccumulator = await loadTodayAccumulator(env);
  const previousMonthAccumulator = await loadMonthAccumulator(env);
  const previousHourBuckets = await loadHourBuckets(env);
  const computed = await computeStatus(env, previousAccumulator, previousMonthAccumulator, previousHourBuckets, now);
  await persistComputedStatus(env, computed, now);
  return computed.status;
}

/**
 * Reads the cached status snapshot for GET /status. If it's missing or has
 * expired (the cron hasn't run recently), falls back to computing live and
 * opportunistically writes the result back to KV. Pass `forceRefresh` to
 * skip the cache and always compute live — e.g. a manual "refresh" from the
 * web dashboard, where the user has explicitly chosen to wait a couple of
 * seconds for a reading no older than the smart meter's own last report.
 */
export async function getOrComputeStatus(
  env: Env,
  now: Date = new Date(),
  forceRefresh = false,
): Promise<StatusResponse> {
  if (forceRefresh) {
    return refreshStatus(env, now);
  }

  const snapshot = await getJson<StatusResponse>(env.OCTOMON_KV, STATUS_SNAPSHOT_KV_KEY);
  if (snapshot) {
    const ageSeconds = secondsBetween(new Date(snapshot.generatedAt), now);
    return {
      ...snapshot,
      stale: ageSeconds > STALE_THRESHOLD_SECONDS,
      snapshotAgeSeconds: ageSeconds,
    };
  }

  return refreshStatus(env, now);
}

/**
 * Fetches consumption for the DAILY_HISTORY_DAYS window ending `endExclusive`,
 * narrowing the window toward `endExclusive` on a 404 rather than failing
 * outright. Octopus 404s the *entire* request if `periodFrom` predates the
 * meter's earliest reading (e.g. a newly set up account, or one only
 * recently switched onto a working MPAN/meter serial) rather than returning
 * partial results for the days it does have — so a fixed 30-day lookback
 * would otherwise fail completely for any account younger than that, even
 * though some of those days have perfectly good data. Halving the window on
 * each 404 finds the largest window Octopus will actually serve in at most
 * a handful of extra requests.
 */
async function fetchHistoricalConsumptionNarrowing(
  env: Env,
  todayKey: string,
  endExclusive: Date,
): Promise<ConsumptionInterval[]> {
  for (let windowDays = DAILY_HISTORY_DAYS; windowDays >= 1; windowDays = Math.floor(windowDays / 2)) {
    const start = londonMidnightUtc(addDaysToDateKey(todayKey, -windowDays));
    try {
      return await fetchHistoricalConsumption(env, start, endExclusive);
    } catch (error) {
      if (!(error instanceof OctopusConsumptionError) || error.status !== 404 || windowDays === 1) {
        throw error;
      }
    }
  }
  return [];
}

/**
 * Derives per-day totals directly from the hour-bucket accumulator — the
 * same already-cached KV state backing the 24-hour chart and the
 * "yesterday" stat — rather than Octopus's REST consumption endpoint. Used
 * by computeDailyHistory as a fallback when that endpoint won't serve
 * anything usable at all (see there): this data is already sitting in KV
 * from the cron's live telemetry polling, so it can never 404 or lag, but
 * it only reaches back as far as HOUR_BUCKET_RETENTION_HOURS (currently
 * ~8 days) rather than the full 30 — real history the Worker has already
 * collected, just less of it.
 */
function computeDailyHistoryFromHourBuckets(
  state: HourBucketsState | null,
  now: Date,
): DailyHistoryEntry[] {
  if (!state) return [];
  const todayKey = londonDateKey(now);
  const totalsByDay = new Map<string, { kwh: number; costGbp: number }>();

  for (const bucket of state.buckets) {
    const dayKey = londonDateKey(new Date(bucket.hourStart));
    if (dayKey === todayKey) continue;
    const totals = totalsByDay.get(dayKey) ?? { kwh: 0, costGbp: 0 };
    totals.kwh += bucket.kwhSoFar;
    totals.costGbp += bucket.costGbpSoFar;
    totalsByDay.set(dayKey, totals);
  }

  return [...totalsByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, totals]) => ({ dateKey, kwh: totals.kwh, costGbp: totals.costGbp }));
}

/**
 * Computes per-day totals for up to the last DAILY_HISTORY_DAYS complete
 * Europe/London calendar days (never including today, which is always
 * still in progress), via a REST consumption fetch spanning the whole
 * window (narrowed automatically if the account doesn't have that much
 * history yet — see fetchHistoricalConsumptionNarrowing), priced per-day
 * against each day's published unit rates (cached individually via
 * fetchUnitRatesForDay, so repeat calls across overlapping windows stay
 * cheap). A day with no consumption data at all is omitted entirely rather
 * than padded with a zero entry, so the list shows whatever history
 * actually exists instead of waiting for the full window to fill up.
 *
 * If Octopus's consumption endpoint won't serve anything at all (every
 * window down to a single day 404s — seen in practice on an account whose
 * meter/tariff config was only recently fixed, where the REST endpoint
 * hadn't caught up yet even though live telemetry was working fine) this
 * falls back to computeDailyHistoryFromHourBuckets instead of failing the
 * whole request, same "best-effort, degrade gracefully" approach already
 * used for the month backfill.
 */
export async function computeDailyHistory(
  env: Env,
  now: Date = new Date(),
): Promise<DailyHistoryEntry[]> {
  const todayKey = londonDateKey(now);
  const endExclusive = londonMidnightUtc(todayKey);

  let intervals: ConsumptionInterval[];
  try {
    intervals = await fetchHistoricalConsumptionNarrowing(env, todayKey, endExclusive);
  } catch (error) {
    console.error(
      "octo-mon /history: Octopus consumption endpoint unavailable, falling back to accumulated hour-bucket data:",
      error,
    );
    return computeDailyHistoryFromHourBuckets(await loadHourBuckets(env), now);
  }

  const ratesCache = new Map<string, UnitRate[]>();
  const totalsByDay = new Map<string, { kwh: number; costGbp: number }>();
  const daysWithData = new Set<string>();

  for (const interval of intervals) {
    const intervalStart = new Date(interval.intervalStart);
    const dayKey = londonDateKey(intervalStart);
    daysWithData.add(dayKey);

    let rates = ratesCache.get(dayKey);
    if (!rates) {
      rates = await fetchUnitRatesForDay(env, dayKey);
      ratesCache.set(dayKey, rates);
    }

    const rate = findRateForInstant(rates, intervalStart);
    if (!rate) continue;

    const totals = totalsByDay.get(dayKey) ?? { kwh: 0, costGbp: 0 };
    totals.kwh += interval.consumptionKwh;
    totals.costGbp += (interval.consumptionKwh * rate.pencePerKwh) / 100;
    totalsByDay.set(dayKey, totals);
  }

  const days: DailyHistoryEntry[] = [];
  for (let i = DAILY_HISTORY_DAYS; i >= 1; i--) {
    const dateKey = addDaysToDateKey(todayKey, -i);
    if (!daysWithData.has(dateKey)) continue;
    const totals = totalsByDay.get(dateKey) ?? { kwh: 0, costGbp: 0 };
    days.push({ dateKey, kwh: totals.kwh, costGbp: totals.costGbp });
  }

  return days;
}

/**
 * Reads the cached daily-history snapshot for GET /history, computing and
 * caching a fresh one if it's missing or has expired. Used by the
 * dashboard's "LAST 30 DAYS" list and the large widget's compact daily
 * history chart — small/medium widgets have no room for it and don't call
 * this endpoint.
 */
export async function getOrComputeDailyHistory(
  env: Env,
  now: Date = new Date(),
): Promise<DailyHistoryResponse> {
  const cached = await getJson<DailyHistoryResponse>(env.OCTOMON_KV, DAILY_HISTORY_KV_KEY);
  if (cached) return cached;

  const response: DailyHistoryResponse = {
    days: await computeDailyHistory(env, now),
    generatedAt: now.toISOString(),
  };
  await putJson(env.OCTOMON_KV, DAILY_HISTORY_KV_KEY, response, {
    expirationTtl: DAILY_HISTORY_TTL_SECONDS,
  });
  return response;
}
