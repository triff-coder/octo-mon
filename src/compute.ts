import { getJson, putJson } from "./cache";
import {
  fetchAgileRatesForDay,
  fetchHistoricalConsumption,
  fetchPlannedDispatches,
  fetchTelemetry,
  obtainKrakenJwt,
} from "./octopus";
import type { DispatchWindow } from "./octopus";
import {
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
  AgileRate,
  Env,
  HourBucketsState,
  MonthAccumulator,
  StatusResponse,
  TodayAccumulator,
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
 * Applies newly-fetched telemetry points to rolling per-UTC-hour buckets,
 * pricing each point the same way as the today/month accumulators. Unlike
 * those, this never resets — a point's hour bucket is created on demand and
 * buckets simply age out (see HOUR_BUCKET_RETENTION_HOURS) once they're
 * older than the widget's 24-hour chart window needs.
 */
export function advanceHourBuckets(
  state: HourBucketsState | null,
  points: { readAt: string; consumptionDeltaKwh: number }[],
  ratesByDay: Map<string, AgileRate[]>,
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
 * Each entry also carries `weeklyAvgCostGbp`: the average cost of that same
 * hour-of-day (e.g. "14:00 UTC") over up to the preceding 7 days, averaged
 * over however many of those days actually have data (0 if none yet) — lets
 * the widget plot "this hour vs. what this hour usually costs".
 */
export function buildHourlyBuckets(
  state: HourBucketsState,
  now: Date,
): { hourStart: string; costGbp: number; weeklyAvgCostGbp: number }[] {
  const currentHourStartMs = hourStartUtc(now).getTime();
  const bucketByStart = new Map(state.buckets.map((b) => [b.hourStart, b]));
  const result: { hourStart: string; costGbp: number; weeklyAvgCostGbp: number }[] = [];

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
      weeklyAvgCostGbp: weeklyCount > 0 ? weeklySum / weeklyCount : 0,
    });
  }

  return result;
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
  todayRates: AgileRate[],
  now: Date,
): Promise<AgileRate[]> {
  let dispatches: DispatchWindow[];
  try {
    dispatches = await fetchPlannedDispatches(env, jwt);
  } catch {
    return [];
  }
  if (dispatches.length === 0 || todayRates.length === 0) return [];

  const offPeakRate = Math.min(...todayRates.map((r) => r.pencePerKwh));
  const nowMs = now.getTime();

  const slots: AgileRate[] = [];
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
  const todayRates = await fetchAgileRatesForDay(env, todayKey);
  const ratesByDay = new Map<string, AgileRate[]>([[todayKey, todayRates]]);

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
  const nextAgileSlots = await resolveNextAgileSlots(env, jwt, todayRates, now);

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
    monthBackfillError: backfillError,
    lastHourCostGbp,
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
