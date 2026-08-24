import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceHourBuckets,
  advanceMonthAccumulator,
  advanceTodayAccumulator,
  buildHourlyBuckets,
  computeStatus,
  findRateForInstant,
  getOrComputeStatus,
  loadHourBuckets,
  loadMonthAccumulator,
  loadTodayAccumulator,
  persistComputedStatus,
} from "../src/compute";
import type {
  Env,
  HourBucketsState,
  MonthAccumulator,
  StatusResponse,
  TodayAccumulator,
  UnitRate,
} from "../src/types";

const testEnv = env as unknown as Env;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockApiOptions {
  telemetry?: { readAt: string; demand: string | number; consumptionDelta: string | number }[];
  /** Price used for every day's rate window (the window itself is derived from the request). */
  pencePerKwh?: number;
  /** Historical consumption intervals returned by the REST consumption endpoint (for backfill). */
  consumption?: { consumptionKwh: number; intervalStart: string; intervalEnd: string }[];
  /** Simulates the consumption endpoint failing (e.g. wrong MPAN/serial, no data yet). */
  consumptionFails?: boolean;
}

function mockOctopusApi(opts: MockApiOptions) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();

    if (url.includes("/graphql/")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { query: string };
      if (body.query.includes("obtainKrakenToken")) {
        return jsonResponse({ data: { obtainKrakenToken: { token: "jwt-1" } } });
      }
      if (body.query.includes("smartMeterTelemetry")) {
        return jsonResponse({ data: { smartMeterTelemetry: opts.telemetry ?? [] } });
      }
      throw new Error(`Unexpected GraphQL query: ${body.query}`);
    }

    if (url.includes("/standard-unit-rates/")) {
      // Derive the rate's validity window from the requested period so it
      // always covers whichever day is actually being priced (today, or a
      // backfilled earlier day in the billing period).
      const parsedUrl = new URL(url);
      const periodFrom = parsedUrl.searchParams.get("period_from") ?? "2026-01-15T00:00:00.000Z";
      const periodTo = parsedUrl.searchParams.get("period_to") ?? "2026-01-16T00:00:00.000Z";
      const pencePerKwh = opts.pencePerKwh ?? 20;
      return jsonResponse({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            value_exc_vat: pencePerKwh / 1.05,
            value_inc_vat: pencePerKwh,
            valid_from: periodFrom,
            valid_to: periodTo,
            payment_method: "DIRECT_DEBIT",
          },
        ],
      });
    }

    if (url.includes("/consumption/")) {
      if (opts.consumptionFails) {
        return new Response("not found", { status: 404 });
      }
      const results = (opts.consumption ?? []).map((c) => ({
        consumption: c.consumptionKwh,
        interval_start: c.intervalStart,
        interval_end: c.intervalEnd,
      }));
      return jsonResponse({ count: results.length, next: null, previous: null, results });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

beforeEach(async () => {
  const kv = testEnv.OCTOMON_KV;
  const list = await kv.list();
  await Promise.all(list.keys.map((k) => kv.delete(k.name)));

  testEnv.OCTOPUS_API_KEY = "sk_test_123";
  testEnv.OCTOPUS_ACCOUNT_NUMBER = "A-TEST1234";
  testEnv.OCTOPUS_DEVICE_ID = "00-00-00-00-00-00-00-00";
  testEnv.OCTOPUS_PRODUCT_CODE = "AGILE-24-10-01";
  testEnv.OCTOPUS_TARIFF_CODE = "E-1R-AGILE-24-10-01-C";
  testEnv.OCTOPUS_MPAN = "1234567890123";
  testEnv.OCTOPUS_METER_SERIAL = "12A3456789";
});

describe("findRateForInstant", () => {
  const rates: UnitRate[] = [
    { pencePerKwh: 20, validFrom: "2026-01-15T10:00:00Z", validTo: "2026-01-15T10:30:00Z" },
    { pencePerKwh: 25, validFrom: "2026-01-15T10:30:00Z", validTo: "2026-01-15T11:00:00Z" },
  ];

  it("finds the rate whose window contains the instant (validFrom inclusive, validTo exclusive)", () => {
    expect(findRateForInstant(rates, new Date("2026-01-15T10:00:00Z"))?.pencePerKwh).toBe(20);
    expect(findRateForInstant(rates, new Date("2026-01-15T10:29:59Z"))?.pencePerKwh).toBe(20);
    expect(findRateForInstant(rates, new Date("2026-01-15T10:30:00Z"))?.pencePerKwh).toBe(25);
  });

  it("returns null when no rate covers the instant", () => {
    expect(findRateForInstant(rates, new Date("2026-01-15T12:00:00Z"))).toBeNull();
  });
});

describe("advanceTodayAccumulator", () => {
  const rates: UnitRate[] = [
    { pencePerKwh: 20, validFrom: "2026-01-15T10:00:00Z", validTo: "2026-01-15T10:30:00Z" },
  ];
  const ratesByDay = new Map([["2026-01-15", rates]]);
  const now = new Date("2026-01-15T10:15:00Z");

  it("accumulates kWh and cost for new points, starting from null", () => {
    const points = [
      { readAt: "2026-01-15T10:00:00Z", consumptionDeltaKwh: 1 },
      { readAt: "2026-01-15T10:10:00Z", consumptionDeltaKwh: 2 },
    ];

    const acc = advanceTodayAccumulator(null, points, ratesByDay, now);

    expect(acc.kwhSoFar).toBeCloseTo(3);
    expect(acc.costGbpSoFar).toBeCloseTo((1 * 20) / 100 + (2 * 20) / 100);
    expect(acc.lastReadingAt).toBe("2026-01-15T10:10:00Z");
    expect(acc.dateKey).toBe("2026-01-15");
  });

  it("does not double-count points at or before the accumulator's last reading", () => {
    const existing: TodayAccumulator = {
      dateKey: "2026-01-15",
      kwhSoFar: 1,
      costGbpSoFar: 0.2,
      lastReadingAt: "2026-01-15T10:05:00Z",
    };
    const points = [
      { readAt: "2026-01-15T10:00:00Z", consumptionDeltaKwh: 1 }, // before cutoff, skipped
      { readAt: "2026-01-15T10:05:00Z", consumptionDeltaKwh: 1 }, // at cutoff, skipped
      { readAt: "2026-01-15T10:10:00Z", consumptionDeltaKwh: 2 }, // new
    ];

    const acc = advanceTodayAccumulator(existing, points, ratesByDay, now);

    expect(acc.kwhSoFar).toBeCloseTo(3); // 1 (existing) + 2 (new)
    expect(acc.lastReadingAt).toBe("2026-01-15T10:10:00Z");
  });

  it("does not mutate the accumulator object passed in", () => {
    const existing: TodayAccumulator = {
      dateKey: "2026-01-15",
      kwhSoFar: 1,
      costGbpSoFar: 0.2,
      lastReadingAt: "2026-01-15T10:05:00Z",
    };
    const frozenCopy = { ...existing };

    advanceTodayAccumulator(
      existing,
      [{ readAt: "2026-01-15T10:10:00Z", consumptionDeltaKwh: 2 }],
      ratesByDay,
      now,
    );

    expect(existing).toEqual(frozenCopy);
  });

  it("resets the accumulator when the previous reading was on a different local day", () => {
    const yesterday: TodayAccumulator = {
      dateKey: "2026-01-14",
      kwhSoFar: 99,
      costGbpSoFar: 20,
      lastReadingAt: "2026-01-14T23:00:00Z",
    };

    const acc = advanceTodayAccumulator(
      yesterday,
      [{ readAt: "2026-01-15T10:00:00Z", consumptionDeltaKwh: 1 }],
      ratesByDay,
      now,
    );

    expect(acc.dateKey).toBe("2026-01-15");
    expect(acc.kwhSoFar).toBeCloseTo(1);
  });

  it("skips (but still advances past) a point with no matching rate", () => {
    const points = [{ readAt: "2026-01-15T11:00:00Z", consumptionDeltaKwh: 5 }]; // outside rates window
    const acc = advanceTodayAccumulator(null, points, ratesByDay, now);

    expect(acc.kwhSoFar).toBe(0);
    expect(acc.costGbpSoFar).toBe(0);
    expect(acc.lastReadingAt).toBe("2026-01-15T11:00:00Z");
  });
});

describe("advanceMonthAccumulator", () => {
  const rates: UnitRate[] = [
    { pencePerKwh: 20, validFrom: "2026-01-15T10:00:00Z", validTo: "2026-01-15T10:30:00Z" },
  ];
  const ratesByDay = new Map([["2026-01-15", rates]]);
  const now = new Date("2026-01-15T10:15:00Z"); // within the 2025-12-20 billing period

  it("accumulates kWh and cost for new points, starting from null", () => {
    const points = [
      { readAt: "2026-01-15T10:00:00Z", consumptionDeltaKwh: 1 },
      { readAt: "2026-01-15T10:10:00Z", consumptionDeltaKwh: 2 },
    ];

    const acc = advanceMonthAccumulator(null, points, ratesByDay, now);

    expect(acc.kwhSoFar).toBeCloseTo(3);
    expect(acc.periodKey).toBe("2025-12-20");
  });

  it("does not double-count points at or before the accumulator's last reading", () => {
    const existing: MonthAccumulator = {
      periodKey: "2025-12-20",
      kwhSoFar: 10,
      costGbpSoFar: 2,
      lastReadingAt: "2026-01-15T10:05:00Z",
    };
    const points = [
      { readAt: "2026-01-15T10:00:00Z", consumptionDeltaKwh: 1 }, // before cutoff, skipped
      { readAt: "2026-01-15T10:10:00Z", consumptionDeltaKwh: 2 }, // new
    ];

    const acc = advanceMonthAccumulator(existing, points, ratesByDay, now);

    expect(acc.kwhSoFar).toBeCloseTo(12); // 10 (existing) + 2 (new)
  });

  it("resets when the previous reading was in a different billing period", () => {
    const lastMonth: MonthAccumulator = {
      periodKey: "2025-11-20",
      kwhSoFar: 250,
      costGbpSoFar: 50,
      lastReadingAt: "2025-12-19T23:00:00Z",
    };

    const acc = advanceMonthAccumulator(
      lastMonth,
      [{ readAt: "2026-01-15T10:00:00Z", consumptionDeltaKwh: 1 }],
      ratesByDay,
      now,
    );

    expect(acc.periodKey).toBe("2025-12-20");
    expect(acc.kwhSoFar).toBeCloseTo(1);
  });
});

describe("advanceHourBuckets", () => {
  const rates: UnitRate[] = [
    { pencePerKwh: 20, validFrom: "2026-01-15T10:00:00Z", validTo: "2026-01-15T11:30:00Z" },
  ];
  const ratesByDay = new Map([["2026-01-15", rates]]);
  const now = new Date("2026-01-15T11:15:00Z");

  it("buckets points into their containing UTC clock hour, starting from null", () => {
    const points = [
      { readAt: "2026-01-15T10:15:00Z", consumptionDeltaKwh: 1 },
      { readAt: "2026-01-15T10:45:00Z", consumptionDeltaKwh: 2 },
      { readAt: "2026-01-15T11:05:00Z", consumptionDeltaKwh: 4 },
    ];

    const state = advanceHourBuckets(null, points, ratesByDay, now);

    expect(state.buckets).toHaveLength(2);
    const tenHour = state.buckets.find((b) => b.hourStart === "2026-01-15T10:00:00.000Z");
    const elevenHour = state.buckets.find((b) => b.hourStart === "2026-01-15T11:00:00.000Z");
    expect(tenHour?.kwhSoFar).toBeCloseTo(3);
    expect(tenHour?.costGbpSoFar).toBeCloseTo((3 * 20) / 100);
    expect(elevenHour?.kwhSoFar).toBeCloseTo(4);
    expect(state.lastReadingAt).toBe("2026-01-15T11:05:00Z");
  });

  it("does not double-count points at or before the state's last reading", () => {
    const existing: HourBucketsState = {
      buckets: [{ hourStart: "2026-01-15T10:00:00.000Z", kwhSoFar: 1, costGbpSoFar: 0.2 }],
      lastReadingAt: "2026-01-15T10:15:00Z",
    };
    const points = [
      { readAt: "2026-01-15T10:15:00Z", consumptionDeltaKwh: 1 }, // at cutoff, skipped
      { readAt: "2026-01-15T10:45:00Z", consumptionDeltaKwh: 2 }, // new, same hour
    ];

    const state = advanceHourBuckets(existing, points, ratesByDay, now);

    const tenHour = state.buckets.find((b) => b.hourStart === "2026-01-15T10:00:00.000Z");
    expect(tenHour?.kwhSoFar).toBeCloseTo(3); // 1 (existing) + 2 (new)
  });

  it("does not mutate the state object passed in", () => {
    const existing: HourBucketsState = {
      buckets: [{ hourStart: "2026-01-15T10:00:00.000Z", kwhSoFar: 1, costGbpSoFar: 0.2 }],
      lastReadingAt: "2026-01-15T10:15:00Z",
    };
    const frozenCopy = JSON.parse(JSON.stringify(existing));

    advanceHourBuckets(
      existing,
      [{ readAt: "2026-01-15T10:45:00Z", consumptionDeltaKwh: 2 }],
      ratesByDay,
      now,
    );

    expect(existing).toEqual(frozenCopy);
  });

  it("ages out buckets older than the retention window (~8 days) instead of growing forever", () => {
    const existing: HourBucketsState = {
      buckets: [{ hourStart: "2026-01-01T10:00:00.000Z", kwhSoFar: 5, costGbpSoFar: 1 }], // 14 days old
      lastReadingAt: "2026-01-01T10:15:00Z",
    };

    const state = advanceHourBuckets(
      existing,
      [{ readAt: "2026-01-15T10:15:00Z", consumptionDeltaKwh: 1 }],
      ratesByDay,
      now,
    );

    expect(state.buckets.find((b) => b.hourStart === "2026-01-01T10:00:00.000Z")).toBeUndefined();
  });

  it("keeps a bucket from a week ago, since the weekly average needs it", () => {
    const existing: HourBucketsState = {
      buckets: [{ hourStart: "2026-01-08T10:00:00.000Z", kwhSoFar: 5, costGbpSoFar: 1 }], // 7 days old
      lastReadingAt: "2026-01-08T10:15:00Z",
    };

    const state = advanceHourBuckets(
      existing,
      [{ readAt: "2026-01-15T10:15:00Z", consumptionDeltaKwh: 1 }],
      ratesByDay,
      now,
    );

    expect(state.buckets.find((b) => b.hourStart === "2026-01-08T10:00:00.000Z")).toBeDefined();
  });
});

describe("buildHourlyBuckets", () => {
  it("normalizes to exactly 24 entries covering the last 24 complete UTC hours, oldest first", () => {
    const now = new Date("2026-01-15T11:30:00Z"); // current (incomplete) hour starts at 11:00
    const state: HourBucketsState = {
      buckets: [
        { hourStart: "2026-01-15T10:00:00.000Z", kwhSoFar: 2, costGbpSoFar: 0.4 },
        { hourStart: "2026-01-15T11:00:00.000Z", kwhSoFar: 9, costGbpSoFar: 1.8 }, // in-progress, excluded
      ],
      lastReadingAt: "2026-01-15T11:15:00Z",
    };

    const buckets = buildHourlyBuckets(state, now);

    expect(buckets).toHaveLength(24);
    expect(buckets[0]?.hourStart).toBe("2026-01-14T11:00:00.000Z"); // oldest
    expect(buckets.at(-1)?.hourStart).toBe("2026-01-15T10:00:00.000Z"); // most recent complete hour
    expect(buckets.at(-1)?.costGbp).toBeCloseTo(0.4);
    // The current in-progress hour never appears.
    expect(buckets.some((b) => b.hourStart === "2026-01-15T11:00:00.000Z")).toBe(false);
  });

  it("reports £0 for hours with no bucket yet rather than omitting them", () => {
    const now = new Date("2026-01-15T11:30:00Z");
    const state: HourBucketsState = { buckets: [], lastReadingAt: new Date(0).toISOString() };

    const buckets = buildHourlyBuckets(state, now);

    expect(buckets).toHaveLength(24);
    expect(buckets.every((b) => b.costGbp === 0)).toBe(true);
    expect(buckets.every((b) => b.weeklyAvgCostGbp === 0)).toBe(true);
  });

  it("averages the same hour-of-day across however many of the last 7 days have data", () => {
    const now = new Date("2026-01-15T11:30:00Z");
    const targetHour = "2026-01-15T10:00:00.000Z"; // the most recent complete hour
    const state: HourBucketsState = {
      buckets: [
        { hourStart: targetHour, kwhSoFar: 1, costGbpSoFar: 0.5 },
        // Same hour-of-day, 1 and 2 days back — averaged into weeklyAvgCostGbp.
        { hourStart: "2026-01-14T10:00:00.000Z", kwhSoFar: 1, costGbpSoFar: 0.3 },
        { hourStart: "2026-01-13T10:00:00.000Z", kwhSoFar: 1, costGbpSoFar: 0.1 },
        // A different hour-of-day on a past day must not be pulled in.
        { hourStart: "2026-01-12T15:00:00.000Z", kwhSoFar: 1, costGbpSoFar: 99 },
      ],
      lastReadingAt: "2026-01-15T11:15:00Z",
    };

    const buckets = buildHourlyBuckets(state, now);
    const target = buckets.find((b) => b.hourStart === targetHour);

    expect(target?.costGbp).toBeCloseTo(0.5);
    expect(target?.weeklyAvgCostGbp).toBeCloseTo((0.3 + 0.1) / 2);
  });
});

describe("computeStatus", () => {
  it("computes current demand/cost and today's total from telemetry + rates", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [
          { readAt: "2026-01-15T10:00:00Z", demand: 1000, consumptionDelta: 1000 },
          { readAt: "2026-01-15T10:05:00Z", demand: 2000, consumptionDelta: 2000 },
        ],
        pencePerKwh: 20,
      }),
    );

    const now = new Date("2026-01-15T10:06:00Z");
    const { status, accumulator, monthAccumulator } = await computeStatus(testEnv, null, null, null, now);

    expect(status.currentDemandKw).toBe(2);
    expect(status.currentRate.pencePerKwh).toBe(20);
    expect(status.currentCostPerHourGbp).toBeCloseTo((2 * 20) / 100);
    expect(status.todayTotalKwh).toBeCloseTo(3);
    expect(status.todayTotalCostGbp).toBeCloseTo((3 * 20) / 100);
    expect(status.thisMonthTotalKwh).toBeCloseTo(3);
    expect(status.thisMonthTotalCostGbp).toBeCloseTo((3 * 20) / 100);
    expect(status.billingPeriodStart).toBe("2025-12-20");
    expect(status.stale).toBe(false);
    expect(accumulator.lastReadingAt).toBe("2026-01-15T10:05:00Z");
    expect(monthAccumulator.lastReadingAt).toBe("2026-01-15T10:05:00Z");

    vi.unstubAllGlobals();
  });

  it("resumes from a same-day accumulator without double-counting", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:10:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
      }),
    );

    const previous: TodayAccumulator = {
      dateKey: "2026-01-15",
      kwhSoFar: 5,
      costGbpSoFar: 0.5,
      lastReadingAt: "2026-01-15T10:05:00Z",
    };
    const previousMonth: MonthAccumulator = {
      periodKey: "2025-12-20",
      kwhSoFar: 40,
      costGbpSoFar: 4,
      lastReadingAt: "2026-01-15T10:05:00Z",
    };

    const { status } = await computeStatus(
      testEnv,
      previous,
      previousMonth,
      null,
      new Date("2026-01-15T10:11:00Z"),
    );

    expect(status.todayTotalKwh).toBeCloseTo(6);
    expect(status.todayTotalCostGbp).toBeCloseTo(0.6);
    expect(status.thisMonthTotalKwh).toBeCloseTo(41);
    expect(status.thisMonthTotalCostGbp).toBeCloseTo(4.1);

    vi.unstubAllGlobals();
  });

  it("resets the month total on a billing-period rollover even if today's accumulator hasn't reset", async () => {
    // 2026-01-20T00:00:00Z is still within the same London calendar day as
    // a hypothetical earlier-today reading, but crosses the 20th billing
    // boundary, so the month accumulator must reset independently.
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-20T10:00:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
      }),
    );

    const previousMonth: MonthAccumulator = {
      periodKey: "2025-12-20",
      kwhSoFar: 99,
      costGbpSoFar: 20,
      lastReadingAt: "2026-01-19T23:00:00Z",
    };

    const { status, monthAccumulator } = await computeStatus(
      testEnv,
      null,
      previousMonth,
      null,
      new Date("2026-01-20T10:01:00Z"),
    );

    expect(monthAccumulator.periodKey).toBe("2026-01-20");
    expect(status.thisMonthTotalKwh).toBeCloseTo(1);

    vi.unstubAllGlobals();
  });

  it("surfaces lastHourCostGbp/lastHourKwh and hourlyBuckets built from the same telemetry", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:15:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
      }),
    );

    const now = new Date("2026-01-15T11:05:00Z"); // the 10:00 hour is now complete
    const { status, hourBuckets } = await computeStatus(testEnv, null, null, null, now);

    expect(status.hourlyBuckets).toHaveLength(24);
    expect(status.hourlyBuckets.at(-1)?.hourStart).toBe("2026-01-15T10:00:00.000Z");
    expect(status.hourlyBuckets.at(-1)?.kwh).toBeCloseTo(1);
    expect(status.lastHourCostGbp).toBeCloseTo(0.1); // 1 kWh @ 10p
    expect(status.lastHourKwh).toBeCloseTo(1);
    expect(hourBuckets.buckets.some((b) => b.hourStart === "2026-01-15T10:00:00.000Z")).toBe(true);

    vi.unstubAllGlobals();
  });

  it("derives yesterdayTotal by summing the previous London calendar day's hour buckets", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:00:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
      }),
    );

    const previousHourBuckets: HourBucketsState = {
      buckets: [
        // Yesterday (2026-01-14) — should be summed into yesterdayTotal.
        { hourStart: "2026-01-14T10:00:00.000Z", kwhSoFar: 1, costGbpSoFar: 0.2 },
        { hourStart: "2026-01-14T14:00:00.000Z", kwhSoFar: 2, costGbpSoFar: 0.3 },
        // The day before that — must not be included.
        { hourStart: "2026-01-13T10:00:00.000Z", kwhSoFar: 99, costGbpSoFar: 99 },
        // Today, still in progress — must not be included either.
        { hourStart: "2026-01-15T09:00:00.000Z", kwhSoFar: 5, costGbpSoFar: 5 },
      ],
      lastReadingAt: "2026-01-15T09:30:00Z",
    };

    const now = new Date("2026-01-15T10:01:00Z");
    const { status } = await computeStatus(testEnv, null, null, previousHourBuckets, now);

    expect(status.yesterdayTotalKwh).toBeCloseTo(3); // 1 + 2
    expect(status.yesterdayTotalCostGbp).toBeCloseTo(0.5); // 0.2 + 0.3

    vi.unstubAllGlobals();
  });

  it("reports a zero yesterdayTotal when there's no hour-bucket history yet", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:00:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
      }),
    );

    const now = new Date("2026-01-15T10:01:00Z");
    const { status } = await computeStatus(testEnv, null, null, null, now);

    expect(status.yesterdayTotalKwh).toBe(0);
    expect(status.yesterdayTotalCostGbp).toBe(0);

    vi.unstubAllGlobals();
  });

  it("caps a cold start's telemetry fetch window instead of requesting since local midnight", async () => {
    // Kraken's smartMeterTelemetry silently returns zero results for an
    // overly wide TEN_SECONDS-grouped window rather than erroring, so a
    // cold start late in the day (no previous accumulator) must not
    // request "since midnight" — that's ~22 hours here.
    const fetchMock = mockOctopusApi({
      telemetry: [{ readAt: "2026-01-15T21:55:00Z", demand: 500, consumptionDelta: 1000 }],
      pencePerKwh: 10,
    });
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-01-15T22:00:00Z"); // 22 hours past local midnight
    await computeStatus(testEnv, null, null, null, now);

    const telemetryCall = fetchMock.mock.calls.find(([, init]) =>
      JSON.parse((init?.body as string) ?? "{}").query?.includes("smartMeterTelemetry"),
    ) as [string, RequestInit];
    const variables = JSON.parse(telemetryCall[1].body as string).variables as { start: string; end: string };

    // Capped to 6 hours back from `now`, not all the way to midnight.
    expect(variables.start).toBe("2026-01-15T16:00:00.000Z");

    vi.unstubAllGlobals();
  });

  it("does not cap the fetch window earlier than local midnight itself", async () => {
    const fetchMock = mockOctopusApi({
      telemetry: [{ readAt: "2026-01-15T02:00:00Z", demand: 500, consumptionDelta: 1000 }],
      pencePerKwh: 10,
    });
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-01-15T02:30:00Z"); // 2.5 hours past local midnight — well under the 6h cap
    await computeStatus(testEnv, null, null, null, now);

    const telemetryCall = fetchMock.mock.calls.find(([, init]) =>
      JSON.parse((init?.body as string) ?? "{}").query?.includes("smartMeterTelemetry"),
    ) as [string, RequestInit];
    const variables = JSON.parse(telemetryCall[1].body as string).variables as { start: string; end: string };

    expect(variables.start).toBe("2026-01-15T00:00:00.000Z");

    vi.unstubAllGlobals();
  });
});

describe("computeStatus nextAgileSlots", () => {
  function slot(pence: number, validFrom: string, validTo: string) {
    return {
      value_exc_vat: pence / 1.05,
      value_inc_vat: pence,
      valid_from: validFrom,
      valid_to: validTo,
      payment_method: "DIRECT_DEBIT",
    };
  }

  interface RawDispatch {
    startDt: string;
    endDt: string;
  }

  interface StubOptions {
    todayRates: ReturnType<typeof slot>[];
    dispatches?: RawDispatch[] | "error";
  }

  // now = 2026-01-20T..., the billing period's own start day, so
  // resolveMonthAccumulator has nothing to backfill and never touches the
  // consumption endpoint (kept out of these fetch mocks for that reason).
  function stubFetch(opts: StubOptions) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/graphql/")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { query: string };
        if (body.query.includes("obtainKrakenToken")) {
          return jsonResponse({ data: { obtainKrakenToken: { token: "jwt-1" } } });
        }
        if (body.query.includes("smartMeterTelemetry")) {
          return jsonResponse({ data: { smartMeterTelemetry: [] } });
        }
        if (body.query.includes("plannedDispatches")) {
          if (opts.dispatches === "error") {
            return jsonResponse({ errors: [{ message: "dispatches unavailable for this account" }] });
          }
          return jsonResponse({ data: { plannedDispatches: opts.dispatches ?? [] } });
        }
        throw new Error(`Unexpected GraphQL query: ${body.query}`);
      }
      if (url.includes("/standard-unit-rates/")) {
        return jsonResponse({ count: opts.todayRates.length, next: null, previous: null, results: opts.todayRates });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  // A fixed 2-rate (Intelligent Octopus Go-style) day: 7p off-peak, 28p day rate.
  const todayRates = [
    slot(7, "2026-01-19T23:30:00Z", "2026-01-20T05:30:00Z"),
    slot(28, "2026-01-20T05:30:00Z", "2026-01-20T23:30:00Z"),
  ];

  it("is empty when there are no planned dispatches", async () => {
    vi.stubGlobal("fetch", stubFetch({ todayRates, dispatches: [] }));

    const now = new Date("2026-01-20T10:00:00Z");
    const { status } = await computeStatus(testEnv, null, null, null, now);

    expect(status.nextAgileSlots).toEqual([]);

    vi.unstubAllGlobals();
  });

  it("chops an upcoming dispatch window into 30-minute slots at today's off-peak rate", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        todayRates,
        dispatches: [{ startDt: "2026-01-20 21:02:49+00:00", endDt: "2026-01-20 22:32:49+00:00" }],
      }),
    );

    const now = new Date("2026-01-20T10:00:00Z");
    const { status } = await computeStatus(testEnv, null, null, null, now);

    expect(status.nextAgileSlots).toEqual([
      { pencePerKwh: 7, validFrom: "2026-01-20T21:02:49.000Z", validTo: "2026-01-20T21:32:49.000Z" },
      { pencePerKwh: 7, validFrom: "2026-01-20T21:32:49.000Z", validTo: "2026-01-20T22:02:49.000Z" },
      { pencePerKwh: 7, validFrom: "2026-01-20T22:02:49.000Z", validTo: "2026-01-20T22:32:49.000Z" },
    ]);

    vi.unstubAllGlobals();
  });

  it("clips a dispatch already in progress to start now, and skips one that's already finished", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        todayRates,
        dispatches: [
          { startDt: "2026-01-20 08:00:00+00:00", endDt: "2026-01-20 09:00:00+00:00" }, // already finished
          { startDt: "2026-01-20 09:45:00+00:00", endDt: "2026-01-20 10:30:00+00:00" }, // in progress
        ],
      }),
    );

    const now = new Date("2026-01-20T10:00:00Z");
    const { status } = await computeStatus(testEnv, null, null, null, now);

    expect(status.nextAgileSlots).toEqual([
      { pencePerKwh: 7, validFrom: "2026-01-20T10:00:00.000Z", validTo: "2026-01-20T10:30:00.000Z" },
    ]);

    vi.unstubAllGlobals();
  });

  it("caps the total at 6 slots across multiple dispatches", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        todayRates,
        dispatches: [
          { startDt: "2026-01-20 10:00:00+00:00", endDt: "2026-01-20 13:00:00+00:00" }, // 6 half-hour slots alone
          { startDt: "2026-01-20 14:00:00+00:00", endDt: "2026-01-20 14:30:00+00:00" },
        ],
      }),
    );

    const now = new Date("2026-01-20T10:00:00Z");
    const { status } = await computeStatus(testEnv, null, null, null, now);

    expect(status.nextAgileSlots).toHaveLength(6);
    expect(status.nextAgileSlots.at(-1)?.validTo).toBe("2026-01-20T13:00:00.000Z");

    vi.unstubAllGlobals();
  });

  it("degrades to an empty list instead of failing the whole request when the dispatches fetch errors", async () => {
    vi.stubGlobal("fetch", stubFetch({ todayRates, dispatches: "error" }));

    const now = new Date("2026-01-20T10:00:00Z");
    const { status } = await computeStatus(testEnv, null, null, null, now);

    expect(status.nextAgileSlots).toEqual([]);

    vi.unstubAllGlobals();
  });
});

describe("computeStatus month/today invariant", () => {
  it("floors this month's total to at least today's, since today is always a subset of the billing period", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [
          { readAt: "2026-01-15T10:00:00Z", demand: 500, consumptionDelta: 1000 },
          { readAt: "2026-01-15T10:03:00Z", demand: 500, consumptionDelta: 1000 },
        ],
        pencePerKwh: 10,
      }),
    );

    // The month accumulator's cursor is ahead of both telemetry points, so
    // advanceMonthAccumulator alone would skip them (kwhSoFar stays 0),
    // while today (starting from null) applies both (kwhSoFar = 2) — the
    // exact skew this floor exists to correct.
    const previousMonth: MonthAccumulator = {
      periodKey: "2025-12-20",
      kwhSoFar: 0,
      costGbpSoFar: 0,
      lastReadingAt: "2026-01-15T10:05:00Z",
    };

    const { status, monthAccumulator } = await computeStatus(
      testEnv,
      null,
      previousMonth,
      null,
      new Date("2026-01-15T10:06:00Z"),
    );

    expect(status.todayTotalKwh).toBeCloseTo(2);
    expect(status.thisMonthTotalKwh).toBeCloseTo(2);
    expect(status.thisMonthTotalKwh).toBeGreaterThanOrEqual(status.todayTotalKwh);
    expect(monthAccumulator.kwhSoFar).toBeCloseTo(2);

    vi.unstubAllGlobals();
  });
});

describe("computeStatus month backfill", () => {
  it("backfills already-elapsed days in the billing period from historical consumption on a cold start", async () => {
    // Billing period starts 2025-12-20; "today" is 2026-01-15. The 14th
    // (an already-completed day within the period, before today) has no
    // accumulator state yet, so it must come from the consumption endpoint.
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:00:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
        consumption: [
          { consumptionKwh: 2, intervalStart: "2026-01-14T10:00:00Z", intervalEnd: "2026-01-14T10:30:00Z" },
          { consumptionKwh: 3, intervalStart: "2026-01-14T10:30:00Z", intervalEnd: "2026-01-14T11:00:00Z" },
        ],
      }),
    );

    const { status, monthAccumulator } = await computeStatus(
      testEnv,
      null,
      null,
      null,
      new Date("2026-01-15T10:01:00Z"),
    );

    // 5 kWh backfilled from the 14th + 1 kWh live from today, all at 10p/kWh.
    expect(status.thisMonthTotalKwh).toBeCloseTo(6);
    expect(status.thisMonthTotalCostGbp).toBeCloseTo(0.6);
    expect(monthAccumulator.periodKey).toBe("2025-12-20");

    vi.unstubAllGlobals();
  });

  it("degrades to a zero-balance month total instead of failing the whole request when backfill fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:00:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
        consumptionFails: true,
      }),
    );

    const { status, monthAccumulator } = await computeStatus(
      testEnv,
      null,
      null,
      null,
      new Date("2026-01-15T10:01:00Z"),
    );

    // Backfill failed, so the month total falls back to just today's live
    // consumption rather than throwing.
    expect(status.thisMonthTotalKwh).toBeCloseTo(1);
    expect(status.thisMonthTotalCostGbp).toBeCloseTo(0.1);
    expect(monthAccumulator.periodKey).toBe("2025-12-20");
    // The failure reason is still surfaced in the response rather than only
    // logged, so it's diagnosable without dashboard log access.
    expect(status.monthBackfillError).toContain("404");

    vi.unstubAllGlobals();
  });

  it("reports monthBackfillError as null once a backfill/carry-forward succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:00:00Z", demand: 500, consumptionDelta: 1000 }],
        pencePerKwh: 10,
      }),
    );

    const { status } = await computeStatus(testEnv, null, null, null, new Date("2026-01-15T10:01:00Z"));

    expect(status.monthBackfillError).toBeNull();

    vi.unstubAllGlobals();
  });

  it("does not call the consumption endpoint when the month accumulator is still current", async () => {
    const fetchMock = mockOctopusApi({
      telemetry: [{ readAt: "2026-01-15T10:10:00Z", demand: 500, consumptionDelta: 1000 }],
      pencePerKwh: 10,
    });
    vi.stubGlobal("fetch", fetchMock);

    const previousMonth: MonthAccumulator = {
      periodKey: "2025-12-20",
      kwhSoFar: 40,
      costGbpSoFar: 4,
      lastReadingAt: "2026-01-15T10:05:00Z",
    };

    await computeStatus(testEnv, null, previousMonth, null, new Date("2026-01-15T10:11:00Z"));

    const consumptionCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/consumption/"),
    );
    expect(consumptionCalls).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it("skips the consumption endpoint when the billing period starts today (nothing to backfill)", async () => {
    const fetchMock = mockOctopusApi({
      telemetry: [{ readAt: "2026-01-20T10:00:00Z", demand: 500, consumptionDelta: 1000 }],
      pencePerKwh: 10,
    });
    vi.stubGlobal("fetch", fetchMock);

    await computeStatus(testEnv, null, null, null, new Date("2026-01-20T10:01:00Z"));

    const consumptionCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/consumption/"),
    );
    expect(consumptionCalls).toHaveLength(0);

    vi.unstubAllGlobals();
  });
});

describe("persistComputedStatus / loadTodayAccumulator / getOrComputeStatus", () => {
  it("round-trips a computed status + accumulator through KV", async () => {
    const now = new Date("2026-01-15T10:06:00Z");
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:00:00Z", demand: 1000, consumptionDelta: 1000 }],
      }),
    );

    const computed = await computeStatus(testEnv, null, null, null, now);
    await persistComputedStatus(testEnv, computed, now);
    vi.unstubAllGlobals();

    const loadedAccumulator = await loadTodayAccumulator(testEnv);
    expect(loadedAccumulator).toEqual(computed.accumulator);

    const loadedMonthAccumulator = await loadMonthAccumulator(testEnv);
    expect(loadedMonthAccumulator).toEqual(computed.monthAccumulator);

    const loadedHourBuckets = await loadHourBuckets(testEnv);
    expect(loadedHourBuckets).toEqual(computed.hourBuckets);
  });

  it("getOrComputeStatus returns a fresh cached snapshot without recomputing", async () => {
    const now = new Date("2026-01-15T10:06:00Z");
    const cached: StatusResponse = {
      generatedAt: new Date(now.getTime() - 60_000).toISOString(),
      currentRate: { pencePerKwh: 20, validFrom: "2026-01-15T10:00:00Z", validTo: "2026-01-15T10:30:00Z" },
      currentDemandKw: 1,
      currentCostPerHourGbp: 0.2,
      todayTotalKwh: 3,
      todayTotalCostGbp: 0.6,
      yesterdayTotalKwh: 2,
      yesterdayTotalCostGbp: 0.4,
      thisMonthTotalKwh: 45,
      thisMonthTotalCostGbp: 9,
      billingPeriodStart: "2025-12-20",
      monthBackfillError: null,
      lastHourCostGbp: 0.4,
      lastHourKwh: 2,
      hourlyBuckets: [],
      nextAgileSlots: [],
      stale: false,
      snapshotAgeSeconds: 0,
    };
    await testEnv.OCTOMON_KV.put("status:latest", JSON.stringify(cached));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOrComputeStatus(testEnv, now);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stale).toBe(false);
    expect(result.snapshotAgeSeconds).toBe(60);
    expect(result.todayTotalKwh).toBe(3);
    expect(result.thisMonthTotalKwh).toBe(45);

    vi.unstubAllGlobals();
  });

  it("getOrComputeStatus flags an old-but-not-yet-expired snapshot as stale", async () => {
    const now = new Date("2026-01-15T10:06:00Z");
    const cached: StatusResponse = {
      generatedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
      currentRate: { pencePerKwh: 20, validFrom: "2026-01-15T09:30:00Z", validTo: "2026-01-15T10:00:00Z" },
      currentDemandKw: 1,
      currentCostPerHourGbp: 0.2,
      todayTotalKwh: 3,
      todayTotalCostGbp: 0.6,
      yesterdayTotalKwh: 2,
      yesterdayTotalCostGbp: 0.4,
      thisMonthTotalKwh: 45,
      thisMonthTotalCostGbp: 9,
      billingPeriodStart: "2025-12-20",
      monthBackfillError: null,
      lastHourCostGbp: 0.4,
      lastHourKwh: 2,
      hourlyBuckets: [],
      nextAgileSlots: [],
      stale: false,
      snapshotAgeSeconds: 0,
    };
    await testEnv.OCTOMON_KV.put("status:latest", JSON.stringify(cached));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOrComputeStatus(testEnv, now);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stale).toBe(true);
    expect(result.snapshotAgeSeconds).toBe(1200);

    vi.unstubAllGlobals();
  });

  it("getOrComputeStatus computes live and persists when no snapshot is cached", async () => {
    const now = new Date("2026-01-15T10:06:00Z");
    vi.stubGlobal(
      "fetch",
      mockOctopusApi({
        telemetry: [{ readAt: "2026-01-15T10:00:00Z", demand: 1500, consumptionDelta: 1500 }],
      }),
    );

    const result = await getOrComputeStatus(testEnv, now);
    vi.unstubAllGlobals();

    expect(result.currentDemandKw).toBe(1.5);
    expect(result.todayTotalKwh).toBeCloseTo(1.5);

    const persisted = await testEnv.OCTOMON_KV.get("status:latest", "json");
    expect(persisted).not.toBeNull();
  });

  it("getOrComputeStatus(forceRefresh) computes live even with a fresh snapshot cached", async () => {
    const now = new Date("2026-01-15T10:06:00Z");
    const cached: StatusResponse = {
      generatedAt: new Date(now.getTime() - 60_000).toISOString(),
      currentRate: { pencePerKwh: 20, validFrom: "2026-01-15T10:00:00Z", validTo: "2026-01-15T10:30:00Z" },
      currentDemandKw: 1,
      currentCostPerHourGbp: 0.2,
      todayTotalKwh: 3,
      todayTotalCostGbp: 0.6,
      yesterdayTotalKwh: 2,
      yesterdayTotalCostGbp: 0.4,
      thisMonthTotalKwh: 45,
      thisMonthTotalCostGbp: 9,
      billingPeriodStart: "2025-12-20",
      monthBackfillError: null,
      lastHourCostGbp: 0.4,
      lastHourKwh: 2,
      hourlyBuckets: [],
      nextAgileSlots: [],
      stale: false,
      snapshotAgeSeconds: 0,
    };
    await testEnv.OCTOMON_KV.put("status:latest", JSON.stringify(cached));

    const fetchMock = mockOctopusApi({
      telemetry: [{ readAt: "2026-01-15T10:05:00Z", demand: 2500, consumptionDelta: 2500 }],
      pencePerKwh: 15,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOrComputeStatus(testEnv, now, true);
    vi.unstubAllGlobals();

    // Reflects the live telemetry, not the cached snapshot's stale values.
    expect(result.currentDemandKw).toBe(2.5);
    expect(fetchMock).toHaveBeenCalled();
  });
});
