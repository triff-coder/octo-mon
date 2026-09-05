import { getJson, putJson } from "./cache";
import {
  fetchHistoricalConsumption,
  fetchPlannedDispatches,
  fetchStandingChargeForDay,
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
// Keyed per Europe/London calendar date (see getOrComputeDailyHistory) so a
// midnight rollover busts the cache immediately instead of waiting out a
// flat TTL — computeDailyHistory's output depends on `todayKey` (it's the
// exclusive upper bound of the window), so yesterday's cached snapshot is
// wrong the moment a new day starts, not just stale.
const DAILY_HISTORY_KV_KEY_PREFIX = "history:daily:";
// This settles slowly (consumption REST data lags) and never changes for
// days that are already fully in the past, so there's no benefit to
// refreshing it anywhere near as often as /status — cache-or-recompute on
// a long TTL, same pattern as fetchUnitRatesForDay's per-day rate cache.
// Purely an upper bound now that the key is date-scoped: it just controls
// how long an unused day's entry lingers in KV before expiring.
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
      ? { ...accumulator, dailyCostsGbp: { ...(accumulator.dailyCostsGbp ?? {}) } }
      : {
          periodKey,
          kwhSoFar: 0,
          costGbpSoFar: 0,
          lastReadingAt: new Date(0).toISOString(),
          dailyCostsGbp: {},
        };

  const lastAppliedMs = new Date(acc.lastReadingAt).getTime();

  for (const point of points) {
    const pointMs = new Date(point.readAt).getTime();
    if (pointMs <= lastAppliedMs) continue;

    const pointDate = new Date(point.readAt);
    const dayKey = londonDateKey(pointDate);
    const rates = ratesByDay.get(dayKey) ?? [];
    const rate = findRateForInstant(rates, pointDate);

    if (rate) {
      const costGbp = (point.consumptionDeltaKwh * rate.pencePerKwh) / 100;
      acc.kwhSoFar += point.consumptionDeltaKwh;
      acc.costGbpSoFar += costGbp;
      // Recorded per-day as well as in the running total, so
      // predictMonthCostGbp can tell a day with no data from a £0 day
      // without ever asking Octopus. See MonthAccumulator.dailyCostsGbp.
      acc.dailyCostsGbp[dayKey] = (acc.dailyCostsGbp[dayKey] ?? 0) + costGbp;
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
 * The average cost of the hour starting at `hourStartMs` over up to the
 * preceding `WEEKLY_AVERAGE_SAMPLE_DAYS` days (same hour-of-day, one or more
 * exact 24h multiples back), averaged over however many of those days
 * actually have a bucket (0 if none yet). Shared by buildHourlyBuckets (past
 * hours, for the chart's "vs. usual" marks) and predictTodayCostGbp (future
 * hours still to come today, which have exactly the same "what did this
 * hour-of-day cost on past days" question).
 */
function averageWeeklyCostForHour(bucketByStart: Map<string, { costGbpSoFar: number }>, hourStartMs: number): number {
  let weeklySum = 0;
  let weeklyCount = 0;
  for (let day = 1; day <= WEEKLY_AVERAGE_SAMPLE_DAYS; day++) {
    const pastBucket = bucketByStart.get(new Date(hourStartMs - day * 24 * 3_600_000).toISOString());
    if (pastBucket) {
      weeklySum += pastBucket.costGbpSoFar;
      weeklyCount += 1;
    }
  }
  return weeklyCount > 0 ? weeklySum / weeklyCount : 0;
}

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

    result.push({
      hourStart: hourStartIso,
      costGbp: bucket?.costGbpSoFar ?? 0,
      kwh: bucket?.kwhSoFar ?? 0,
      weeklyAvgCostGbp: averageWeeklyCostForHour(bucketByStart, hourStartMs),
    });
  }

  return result;
}

/**
 * Predicts today's (Europe/London calendar day) total cost: today's actual
 * cost so far, plus a predicted remainder for the rest of the day built
 * from each hour's average cost over up to the preceding 7 days (see
 * averageWeeklyCostForHour — 0 for an hour with no history yet, so a
 * brand-new account predicts just today's so-far total rather than
 * throwing). The current, still in-progress hour is included too — its
 * predicted *remainder* is the full hour's average minus what's already
 * been accumulated this hour, floored at 0 — rather than skipped outright,
 * which would otherwise omit up to a full hour of expected cost from a
 * prediction checked right after the hour ticks over.
 */
export function predictTodayCostGbp(hourBuckets: HourBucketsState, todayCostSoFarGbp: number, now: Date): number {
  const bucketByStart = new Map(hourBuckets.buckets.map((b) => [b.hourStart, b]));
  const dayEndMs = nextLondonMidnightUtc(now).getTime();
  const currentHourStartMs = hourStartUtc(now).getTime();

  const currentHourCostSoFar = bucketByStart.get(new Date(currentHourStartMs).toISOString())?.costGbpSoFar ?? 0;
  let predictedRemaining = Math.max(0, averageWeeklyCostForHour(bucketByStart, currentHourStartMs) - currentHourCostSoFar);

  for (let hourStartMs = currentHourStartMs + 3_600_000; hourStartMs < dayEndMs; hourStartMs += 3_600_000) {
    predictedRemaining += averageWeeklyCostForHour(bucketByStart, hourStartMs);
  }

  return todayCostSoFarGbp + predictedRemaining;
}

/**
 * The days of this billing period whose recorded cost is trustworthy as a
 * *whole day's* spend, oldest first — the basis for the daily average.
 *
 * Excludes today (still in progress) and the earliest day with data, which
 * is almost always partial: accumulation starts whenever the Worker/meter
 * first reported, mid-afternoon as often as not, so counting it whole would
 * drag the average down. On the rare occasion that first day really was
 * complete, dropping one ordinary day from an average of its peers costs
 * essentially nothing — the asymmetry is worth it.
 */
function completeDataDayKeys(monthAccumulator: MonthAccumulator, todayKey: string): string[] {
  const daily = monthAccumulator.dailyCostsGbp ?? {};
  return Object.keys(daily)
    .filter((dateKey) => dateKey !== todayKey)
    .sort()
    .slice(1);
}

/**
 * Predicts the current Octopus billing period's (see billingPeriodKey) total
 * cost for the *whole* period, entirely from data this Worker already holds
 * — no Octopus lookup involved.
 *
 * Takes the average of the days it has complete data for (see
 * completeDataDayKeys), then fills in every other day of the period at that
 * average: the days before the Worker started recording, the partial first
 * day, and all the days still to come. Today gets `predictedTodayCostGbp`
 * instead, which is finer-grained (built from per-hour averages) than a flat
 * daily rate.
 *
 * The missing early days matter as much as the future ones: they're real
 * days of unrecorded usage, not days that cost nothing, so leaving them out
 * would undercount the period by roughly what they actually cost — and
 * counting them as £0 days in the average would understate the rate on top
 * of that.
 *
 * Falls back to extrapolating today's own prediction across the period when
 * there's no complete day to average yet (the first day or two of a period).
 */
export function predictMonthCostGbp(
  monthAccumulator: MonthAccumulator,
  predictedTodayCostGbp: number,
  now: Date,
): number {
  const todayKey = londonDateKey(now);
  const periodStart = londonMidnightUtc(monthAccumulator.periodKey);
  const periodEnd = nextBillingPeriodStartUtc(now);
  const totalDays = Math.round((periodEnd.getTime() - periodStart.getTime()) / 86_400_000);

  const daily = monthAccumulator.dailyCostsGbp ?? {};
  const completeDays = completeDataDayKeys(monthAccumulator, todayKey);
  if (completeDays.length === 0) return predictedTodayCostGbp * totalDays;

  const completeTotalGbp = completeDays.reduce((sum, dateKey) => sum + (daily[dateKey] ?? 0), 0);
  const avgDailyCostGbp = completeTotalGbp / completeDays.length;
  // Every day of the period that isn't one of the complete days and isn't
  // today: the unrecorded/partial days behind us, plus the days ahead.
  const daysToEstimate = Math.max(0, totalDays - completeDays.length - 1);

  return completeTotalGbp + predictedTodayCostGbp + avgDailyCostGbp * daysToEstimate;
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
 * Fetches consumption for [start, end) the same as fetchHistoricalConsumption,
 * but tolerates `start` predating the meter's earliest actual reading:
 * Octopus 404s the *entire* request in that case rather than returning
 * partial results for the days it does have (same characteristic
 * fetchHistoricalConsumptionNarrowing already works around for /history,
 * generalized here to bisect for the earliest working start date instead of
 * shrinking a fixed lookback window). Binary-searches forward from `start`
 * toward `end` on a 404, so an account/meter that only started reporting
 * partway through the requested range still gets the real data it has,
 * instead of the whole range failing outright.
 *
 * A 404 that persists all the way down to the narrowest possible window
 * (starting the day before `end`) isn't a late-starting meter — something
 * else is wrong (bad MPAN/serial, Octopus outage, ...) — so that case is
 * left to throw/propagate rather than silently treated as "no data".
 */
async function fetchHistoricalConsumptionFromEarliestAvailable(
  env: Env,
  start: Date,
  end: Date,
): Promise<ConsumptionInterval[]> {
  try {
    return await fetchHistoricalConsumption(env, start, end);
  } catch (error) {
    if (!(error instanceof OctopusConsumptionError) || error.status !== 404) throw error;
  }

  let loMs = start.getTime(); // known to 404 (or not yet tried below this point)
  let hiMs = end.getTime(); // known to succeed (trivially -- an empty range never 404s)
  let lastGood: ConsumptionInterval[] | null = null;

  while (hiMs - loMs > 86_400_000) {
    const midMs = loMs + Math.floor((hiMs - loMs) / 2 / 86_400_000) * 86_400_000;
    try {
      lastGood = await fetchHistoricalConsumption(env, new Date(midMs), end);
      hiMs = midMs;
    } catch (error) {
      if (!(error instanceof OctopusConsumptionError) || error.status !== 404) throw error;
      loMs = midMs;
    }
  }

  return lastGood ?? fetchHistoricalConsumption(env, new Date(hiMs), end);
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
    return {
      periodKey,
      kwhSoFar: 0,
      costGbpSoFar: 0,
      lastReadingAt: todayStart.toISOString(),
      dailyCostsGbp: {},
    };
  }

  const intervals = await fetchHistoricalConsumptionFromEarliestAvailable(env, periodStart, todayStart);
  const ratesCache = new Map<string, UnitRate[]>();

  let kwhSoFar = 0;
  let costGbpSoFar = 0;
  const dailyCostsGbp: Record<string, number> = {};

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
      const costGbp = (interval.consumptionKwh * rate.pencePerKwh) / 100;
      kwhSoFar += interval.consumptionKwh;
      costGbpSoFar += costGbp;
      dailyCostsGbp[dayKey] = (dailyCostsGbp[dayKey] ?? 0) + costGbp;
    }
  }

  return { periodKey, kwhSoFar, costGbpSoFar, lastReadingAt: todayStart.toISOString(), dailyCostsGbp };
}

/**
 * Rebuilds `dailyCostsGbp` for an accumulator persisted before that field
 * existed, from the rolling hour buckets this Worker already keeps — no
 * Octopus lookup, which matters because the REST consumption endpoint is
 * exactly what's unavailable on the accounts this field exists to serve.
 *
 * Hour buckets only reach back HOUR_BUCKET_RETENTION_HOURS (~8 days), so on
 * a period already older than that they can't see its earliest days. Any
 * cost the buckets can't account for is therefore known to belong to days
 * before the oldest bucket, and is spread evenly across them — preserving
 * both the true total and the fact that those days had data, rather than
 * leaving them looking like days the Worker never recorded.
 */
function rebuildDailyCostsFromHourBuckets(
  accumulator: MonthAccumulator,
  hourBuckets: HourBucketsState | null,
): Record<string, number> {
  const periodStart = londonMidnightUtc(accumulator.periodKey);
  const dailyCostsGbp: Record<string, number> = {};

  for (const bucket of hourBuckets?.buckets ?? []) {
    const bucketStart = new Date(bucket.hourStart);
    if (bucketStart.getTime() < periodStart.getTime()) continue;
    const dayKey = londonDateKey(bucketStart);
    dailyCostsGbp[dayKey] = (dailyCostsGbp[dayKey] ?? 0) + bucket.costGbpSoFar;
  }

  const dayKeys = Object.keys(dailyCostsGbp).sort();
  if (dayKeys.length === 0) {
    // Nothing to go on: treat the period as having data throughout, which
    // is what the pre-dailyCostsGbp behavior effectively assumed.
    return { [accumulator.periodKey]: accumulator.costGbpSoFar };
  }

  const reconstructedTotal = dayKeys.reduce((sum, k) => sum + dailyCostsGbp[k]!, 0);
  const unaccountedGbp = accumulator.costGbpSoFar - reconstructedTotal;
  const earliestKey = dayKeys[0]!;
  const daysBeforeBuckets = Math.round(
    (londonMidnightUtc(earliestKey).getTime() - periodStart.getTime()) / 86_400_000,
  );
  // Only worth spreading if it amounts to real usage rather than drift
  // between two totals accumulated slightly differently — otherwise a few
  // pence of noise would invent a data day for every day of the period.
  const materialGbp = reconstructedTotal / dayKeys.length / 2;

  if (unaccountedGbp > materialGbp && daysBeforeBuckets > 0) {
    const perDayGbp = unaccountedGbp / daysBeforeBuckets;
    for (let i = 0; i < daysBeforeBuckets; i++) {
      dailyCostsGbp[addDaysToDateKey(accumulator.periodKey, i)] = perDayGbp;
    }
  }

  return dailyCostsGbp;
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
  previousHourBuckets: HourBucketsState | null,
  now: Date,
): Promise<ResolvedMonthAccumulator> {
  if (
    previousMonthAccumulator &&
    isSameBillingPeriod(new Date(previousMonthAccumulator.lastReadingAt), now)
  ) {
    const accumulator = previousMonthAccumulator.dailyCostsGbp
      ? previousMonthAccumulator
      : {
          ...previousMonthAccumulator,
          dailyCostsGbp: rebuildDailyCostsFromHourBuckets(previousMonthAccumulator, previousHourBuckets),
        };
    return { accumulator, backfillError: null };
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
        dailyCostsGbp: {},
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
    previousHourBuckets,
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

  // The standing charge is a flat daily fee charged once per calendar day
  // regardless of consumption, so unlike everything above it can't be priced
  // per telemetry point -- it's folded in here instead of into the
  // accumulators (which stay consumption-only, since they also back the
  // hourly/yesterday figures those must NOT include it). Today's rate is
  // assumed to hold for every elapsed day of the billing period and for
  // every day still to come: standing charges change far less often than
  // unit rates, so this is a reasonable stand-in for fetching each day's own
  // rate individually.
  const standingChargePenceToday = await fetchStandingChargeForDay(env, todayKey);
  const standingChargeGbpToday = standingChargePenceToday / 100;
  const periodStartUtc = londonMidnightUtc(monthAccumulator.periodKey);
  const daysElapsedInPeriod = Math.round((londonMidnightUtc(todayKey).getTime() - periodStartUtc.getTime()) / 86_400_000) + 1;
  const totalDaysInPeriod = Math.round((nextBillingPeriodStartUtc(now).getTime() - periodStartUtc.getTime()) / 86_400_000);
  const monthStandingChargeGbpSoFar = standingChargeGbpToday * daysElapsedInPeriod;
  const predictedMonthStandingChargeGbp = standingChargeGbpToday * totalDaysInPeriod;

  const todayTotalCostGbp = accumulator.costGbpSoFar + standingChargeGbpToday;
  const thisMonthTotalCostGbp = monthAccumulator.costGbpSoFar + monthStandingChargeGbpSoFar;
  const predictedTodayConsumptionCostGbp = predictTodayCostGbp(hourBuckets, accumulator.costGbpSoFar, now);
  const predictedTodayCostGbp = predictedTodayConsumptionCostGbp + standingChargeGbpToday;
  const predictedMonthCostGbp =
    predictMonthCostGbp(monthAccumulator, predictedTodayConsumptionCostGbp, now) + predictedMonthStandingChargeGbp;

  const completeDataDays = completeDataDayKeys(monthAccumulator, todayKey);
  const recordedDayKeys = Object.keys(monthAccumulator.dailyCostsGbp ?? {}).sort();

  const status: StatusResponse = {
    generatedAt: now.toISOString(),
    currentRate: currentRate ?? { pencePerKwh: 0, validFrom: now.toISOString(), validTo: now.toISOString() },
    currentDemandKw,
    currentCostPerHourGbp,
    todayTotalKwh: accumulator.kwhSoFar,
    todayTotalCostGbp,
    yesterdayTotalKwh: yesterdayTotal.kwhSoFar,
    yesterdayTotalCostGbp: yesterdayTotal.costGbpSoFar,
    thisMonthTotalKwh: monthAccumulator.kwhSoFar,
    thisMonthTotalCostGbp,
    billingPeriodStart: monthAccumulator.periodKey,
    monthBackfillError: backfillError,
    firstDataDateKey: recordedDayKeys[0] ?? todayKey,
    completeDataDayCount: completeDataDays.length,
    lastHourCostGbp,
    lastHourKwh,
    hourlyBuckets,
    predictedTodayCostGbp,
    predictedMonthCostGbp,
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
async function computeDailyHistoryFromHourBuckets(
  env: Env,
  state: HourBucketsState | null,
  now: Date,
): Promise<DailyHistoryEntry[]> {
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

  const entries: DailyHistoryEntry[] = [];
  for (const [dateKey, totals] of [...totalsByDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const standingChargePence = await fetchStandingChargeForDay(env, dateKey);
    entries.push({ dateKey, kwh: totals.kwh, costGbp: totals.costGbp + standingChargePence / 100 });
  }
  return entries;
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
 *
 * Each day's total also includes that day's own standing charge (fetched
 * per day, same as unit rates), added only for days that actually have
 * consumption data — a day with no data gets no fabricated standing charge
 * either, consistent with it being omitted entirely rather than padded.
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
    return computeDailyHistoryFromHourBuckets(env, await loadHourBuckets(env), now);
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
    const standingChargePence = await fetchStandingChargeForDay(env, dateKey);
    days.push({ dateKey, kwh: totals.kwh, costGbp: totals.costGbp + standingChargePence / 100 });
  }

  return days;
}

/**
 * Reads the cached daily-history snapshot for GET /history, computing and
 * caching a fresh one if it's missing or has expired. Used by the
 * dashboard's "LAST 30 DAYS" list and the large widget's compact daily
 * history chart — small/medium widgets have no room for it and don't call
 * this endpoint.
 *
 * Pass `forceRefresh` to skip the cache and always recompute — e.g. the
 * dashboard's "Recalculate" button, so a cached snapshot from before a
 * pricing change (like the standing charge being added to these totals)
 * can be replaced on demand instead of waiting out the 12h TTL.
 */
export async function getOrComputeDailyHistory(
  env: Env,
  now: Date = new Date(),
  forceRefresh = false,
): Promise<DailyHistoryResponse> {
  const kvKey = DAILY_HISTORY_KV_KEY_PREFIX + londonDateKey(now);
  if (!forceRefresh) {
    const cached = await getJson<DailyHistoryResponse>(env.OCTOMON_KV, kvKey);
    if (cached) return cached;
  }

  const response: DailyHistoryResponse = {
    days: await computeDailyHistory(env, now),
    generatedAt: now.toISOString(),
  };
  await putJson(env.OCTOMON_KV, kvKey, response, {
    expirationTtl: DAILY_HISTORY_TTL_SECONDS,
  });
  return response;
}
