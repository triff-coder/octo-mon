import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env, StatusResponse } from "../src/types";

const testEnv = env as unknown as Env;

async function callFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  const kv = testEnv.OCTOMON_KV;
  const list = await kv.list();
  await Promise.all(list.keys.map((k) => kv.delete(k.name)));

  testEnv.WIDGET_SHARED_SECRET = "test-secret";
  testEnv.OCTOPUS_API_KEY = "sk_test_123";
  testEnv.OCTOPUS_DEVICE_ID = "00-00-00-00-00-00-00-00";
  testEnv.OCTOPUS_PRODUCT_CODE = "AGILE-24-10-01";
  testEnv.OCTOPUS_TARIFF_CODE = "E-1R-AGILE-24-10-01-C";
  testEnv.OCTOPUS_MPAN = "1234567890123";
  testEnv.OCTOPUS_METER_SERIAL = "12A3456789";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const cachedStatus: StatusResponse = {
  generatedAt: new Date().toISOString(),
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
  firstDataDateKey: "2025-12-20",
  firstDataDateKeyVerified: true,
  firstDataDateKeyError: null,
  lastHourCostGbp: 0.4,
  lastHourKwh: 2,
  hourlyBuckets: [],
  predictedTodayCostGbp: 0,
  predictedMonthCostGbp: 0,
  nextAgileSlots: [],
  stale: false,
  snapshotAgeSeconds: 0,
};

describe("GET /status", () => {
  it("rejects a request with no token", async () => {
    const response = await callFetch(new Request("https://example.com/status"));
    expect(response.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const response = await callFetch(
      new Request("https://example.com/status", { headers: { "X-Widget-Secret": "wrong" } }),
    );
    expect(response.status).toBe(401);
  });

  it("accepts the token via header and returns the cached snapshot", async () => {
    await testEnv.OCTOMON_KV.put("status:latest", JSON.stringify(cachedStatus));

    const response = await callFetch(
      new Request("https://example.com/status", { headers: { "X-Widget-Secret": "test-secret" } }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusResponse;
    expect(body.todayTotalKwh).toBe(3);
  });

  it("accepts the token via query param", async () => {
    await testEnv.OCTOMON_KV.put("status:latest", JSON.stringify(cachedStatus));

    const response = await callFetch(new Request("https://example.com/status?token=test-secret"));
    expect(response.status).toBe(200);
  });

  it("bypasses a fresh cached snapshot and computes live when ?refresh=true", async () => {
    await testEnv.OCTOMON_KV.put("status:latest", JSON.stringify(cachedStatus));

    // A permissive rate window (rather than deriving one from the request,
    // as compute.test.ts's fixture does) keeps this independent of whatever
    // the real system clock happens to be when the test runs.
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const jsonResponse = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

      if (url.includes("/graphql/")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { query: string };
        if (body.query.includes("obtainKrakenToken")) {
          return jsonResponse({ data: { obtainKrakenToken: { token: "jwt-1" } } });
        }
        if (body.query.includes("smartMeterTelemetry")) {
          return jsonResponse({
            data: {
              smartMeterTelemetry: [{ readAt: new Date().toISOString(), demand: 3000, consumptionDelta: 3000 }],
            },
          });
        }
      }
      if (url.includes("/standard-unit-rates/")) {
        return jsonResponse({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              value_exc_vat: 9.52,
              value_inc_vat: 10,
              valid_from: "2000-01-01T00:00:00Z",
              valid_to: "2100-01-01T00:00:00Z",
              payment_method: "DIRECT_DEBIT",
            },
          ],
        });
      }
      if (url.includes("/consumption/")) {
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await callFetch(
      new Request("https://example.com/status?refresh=true", { headers: { "X-Widget-Secret": "test-secret" } }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusResponse;
    // Reflects the live telemetry (3kW), not the cached snapshot's 1kW.
    expect(body.currentDemandKw).toBe(3);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns a clean 500 JSON error instead of an unhandled exception when live computation fails", async () => {
    // No cached snapshot, so /status must compute live; simulate Octopus's
    // API being unreachable/erroring for the very first call it makes.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })),
    );

    const response = await callFetch(
      new Request("https://example.com/status", { headers: { "X-Widget-Secret": "test-secret" } }),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toBeTruthy();
  });
});

describe("GET /history", () => {
  it("rejects a request with no token", async () => {
    const response = await callFetch(new Request("https://example.com/history"));
    expect(response.status).toBe(401);
  });

  it("returns only the days that have consumption data, oldest first", async () => {
    // Derived from the real system clock (rather than hardcoded), since the
    // /history route calls getOrComputeDailyHistory without a fixed `now`.
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      const jsonResponse = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

      if (url.includes("/standard-unit-rates/")) {
        return jsonResponse({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              value_exc_vat: 9.52,
              value_inc_vat: 10,
              valid_from: "2000-01-01T00:00:00Z",
              valid_to: "2100-01-01T00:00:00Z",
              payment_method: "DIRECT_DEBIT",
            },
          ],
        });
      }
      if (url.includes("/consumption/")) {
        return jsonResponse({
          count: 1,
          next: null,
          previous: null,
          results: [
            { consumption: 1, interval_start: `${yesterdayKey}T10:00:00Z`, interval_end: `${yesterdayKey}T10:30:00Z` },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await callFetch(
      new Request("https://example.com/history", { headers: { "X-Widget-Secret": "test-secret" } }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { days: { dateKey: string }[] };
    expect(body.days).toHaveLength(1);
    expect(body.days[0]?.dateKey).toBe(yesterdayKey);
  });
});

describe("GET /dashboard", () => {
  it("rejects a request with no token", async () => {
    const response = await callFetch(new Request("https://example.com/dashboard"));
    expect(response.status).toBe(401);
  });

  it("serves an HTML page embedding the provided token for its own polling", async () => {
    const response = await callFetch(new Request("https://example.com/dashboard?token=test-secret"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<canvas");
    expect(body).toContain('"test-secret"');
  });
});

describe("unknown routes", () => {
  it("returns 404 for other paths", async () => {
    const response = await callFetch(new Request("https://example.com/nope"));
    expect(response.status).toBe(404);
  });
});
