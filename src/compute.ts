import { getJson, putJson } from "./cache";
import { fetchAgileRatesForDay, fetchTelemetry, obtainKrakenJwt } from "./octopus";
import {
  isSameLondonDay,
  londonDateKey,
  londonMidnightUtc,
  nextLondonMidnightUtc,
  secondsBetween,
} from "./time";
import type { AgileRate, Env, StatusResponse, TodayAccumulator } from "./types";

const STATUS_SNAPSHOT_KV_KEY = "status:latest";
const STATUS_SNAPSHOT_TTL_SECONDS = 30 * 60;
const TODAY_ACCUMULATOR_KV_KEY = "today:accumulator";
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

export interface ComputedStatus {
  status: StatusResponse;
  accumulator: TodayAccumulator;
}

/**
 * Orchestrates a full refresh: obtains a Kraken JWT, fetches telemetry since
 * the last known reading, advances the today accumulator, and looks up the
 * current rate/demand for the response payload.
 */
export async function computeStatus(
  env: Env,
  previousAccumulator: TodayAccumulator | null,
  now: Date = new Date(),
): Promise<ComputedStatus> {
  const jwt = await obtainKrakenJwt(env, now);

  const todayKey = londonDateKey(now);
  const todayRates = await fetchAgileRatesForDay(env, todayKey);
  const ratesByDay = new Map<string, AgileRate[]>([[todayKey, todayRates]]);

  // The accumulator resets for a new day (see advanceTodayAccumulator), so
  // whenever it's reused it's always from earlier today; fetchSince is
  // therefore always within today's rates window.
  const fetchSince =
    previousAccumulator && isSameLondonDay(new Date(previousAccumulator.lastReadingAt), now)
      ? new Date(previousAccumulator.lastReadingAt)
      : londonMidnightUtc(todayKey);

  const points = await fetchTelemetry(env, jwt, fetchSince, now);
  const accumulator = advanceTodayAccumulator(previousAccumulator, points, ratesByDay, now);

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
    stale: false,
    snapshotAgeSeconds: 0,
  };

  return { status, accumulator };
}

/** Writes a freshly computed status + accumulator to KV. */
export async function persistComputedStatus(env: Env, computed: ComputedStatus, now: Date): Promise<void> {
  await putJson(env.OCTOMON_KV, STATUS_SNAPSHOT_KV_KEY, computed.status, {
    expirationTtl: STATUS_SNAPSHOT_TTL_SECONDS,
  });
  await putJson(env.OCTOMON_KV, TODAY_ACCUMULATOR_KV_KEY, computed.accumulator, {
    expirationTtl: Math.max(60, secondsBetween(now, nextLondonMidnightUtc(now)) + 3600),
  });
}

export async function loadTodayAccumulator(env: Env): Promise<TodayAccumulator | null> {
  return getJson<TodayAccumulator>(env.OCTOMON_KV, TODAY_ACCUMULATOR_KV_KEY);
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
  const computed = await computeStatus(env, previousAccumulator, now);
  await persistComputedStatus(env, computed, now);
  return computed.status;
}
