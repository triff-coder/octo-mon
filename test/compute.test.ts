import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceMonthAccumulator,
  advanceTodayAccumulator,
  computeStatus,
  findRateForInstant,
  getOrComputeStatus,
  loadMonthAccumulator,
  loadTodayAccumulator,
  persistComputedStatus,
} from "../src/compute";
import type { AgileRate, Env, MonthAccumulator, StatusResponse, TodayAccumulator } from "../src/types";

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
  testEnv.OCTOPUS_DEVICE_ID = "00-00-00-00-00-00-00-00";
  testEnv.OCTOPUS_PRODUCT_CODE = "AGILE-24-10-01";
  testEnv.OCTOPUS_TARIFF_CODE = "E-1R-AGILE-24-10-01-C";
  testEnv.OCTOPUS_MPAN = "1234567890123";
  testEnv.OCTOPUS_METER_SERIAL = "12A3456789";
});

describe("findRateForInstant", () => {
  const rates: AgileRate[] = [
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
  const rates: AgileRate[] = [
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
  const rates: AgileRate[] = [
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
    const { status, accumulator, monthAccumulator } = await computeStatus(testEnv, null, null, now);

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
      new Date("2026-01-20T10:01:00Z"),
    );

    expect(monthAccumulator.periodKey).toBe("2026-01-20");
    expect(status.thisMonthTotalKwh).toBeCloseTo(1);

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
      new Date("2026-01-15T10:01:00Z"),
    );

    // Backfill failed, so the month total falls back to just today's live
    // consumption rather than throwing.
    expect(status.thisMonthTotalKwh).toBeCloseTo(1);
    expect(status.thisMonthTotalCostGbp).toBeCloseTo(0.1);
    expect(monthAccumulator.periodKey).toBe("2025-12-20");

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

    await computeStatus(testEnv, null, previousMonth, new Date("2026-01-15T10:11:00Z"));

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

    await computeStatus(testEnv, null, null, new Date("2026-01-20T10:01:00Z"));

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

    const computed = await computeStatus(testEnv, null, null, now);
    await persistComputedStatus(testEnv, computed, now);
    vi.unstubAllGlobals();

    const loadedAccumulator = await loadTodayAccumulator(testEnv);
    expect(loadedAccumulator).toEqual(computed.accumulator);

    const loadedMonthAccumulator = await loadMonthAccumulator(testEnv);
    expect(loadedMonthAccumulator).toEqual(computed.monthAccumulator);
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
      thisMonthTotalKwh: 45,
      thisMonthTotalCostGbp: 9,
      billingPeriodStart: "2025-12-20",
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
      thisMonthTotalKwh: 45,
      thisMonthTotalCostGbp: 9,
      billingPeriodStart: "2025-12-20",
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
});
