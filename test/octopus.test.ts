import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchHistoricalConsumption,
  fetchPlannedDispatches,
  fetchStandingChargeForDay,
  fetchTelemetry,
  fetchUnitRatesForDay,
  obtainKrakenJwt,
} from "../src/octopus";
import type { Env } from "../src/types";
import consumptionFixture from "./fixtures/consumption.sample.json";
import ratesFixture from "./fixtures/rates.sample.json";
import standingChargesFixture from "./fixtures/standing-charges.sample.json";
import telemetryFixture from "./fixtures/telemetry.sample.json";

const testEnv = env as unknown as Env;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("obtainKrakenJwt", () => {
  it("fetches and caches a token on first call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { obtainKrakenToken: { token: "jwt-1" } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const token = await obtainKrakenJwt(testEnv, new Date("2026-01-15T10:00:00Z"));

    expect(token).toBe("jwt-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).variables).toEqual({ apiKey: "sk_test_123" });
  });

  it("reuses the cached token when it isn't close to expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { obtainKrakenToken: { token: "jwt-1" } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-01-15T10:00:00Z");
    await obtainKrakenJwt(testEnv, now);
    const token = await obtainKrakenJwt(testEnv, new Date(now.getTime() + 60_000));

    expect(token).toBe("jwt-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates once the cached token is close to expiry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { obtainKrakenToken: { token: "jwt-1" } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { obtainKrakenToken: { token: "jwt-2" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-01-15T10:00:00Z");
    await obtainKrakenJwt(testEnv, now);
    const token = await obtainKrakenJwt(testEnv, new Date(now.getTime() + 49 * 60_000));

    expect(token).toBe("jwt-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the GraphQL response contains errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "bad api key" }] })),
    );

    await expect(obtainKrakenJwt(testEnv, new Date("2026-01-15T10:00:00Z"))).rejects.toThrow(
      /bad api key/,
    );
  });
});

describe("fetchTelemetry", () => {
  it("sorts points ascending by readAt and converts units (W→kW, Wh→kWh)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(telemetryFixture)));

    const points = await fetchTelemetry(
      testEnv,
      "jwt-1",
      new Date("2026-01-15T09:55:00Z"),
      new Date("2026-01-15T10:05:00Z"),
    );

    expect(points).toEqual([
      { readAt: "2026-01-15T10:00:00Z", demandKw: 0.842, consumptionDeltaKwh: 0.0023 },
      { readAt: "2026-01-15T10:00:10Z", demandKw: 0.875, consumptionDeltaKwh: 0.0024 },
      { readAt: "2026-01-15T10:00:20Z", demandKw: 0.91, consumptionDeltaKwh: 0.0025 },
    ]);
  });

  it("sends the JWT as an Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(telemetryFixture));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTelemetry(testEnv, "jwt-abc", new Date("2026-01-15T09:55:00Z"), new Date("2026-01-15T10:05:00Z"));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("JWT jwt-abc");
  });

  it("returns an empty array when there are no readings in the window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: { smartMeterTelemetry: [] } })),
    );

    const points = await fetchTelemetry(
      testEnv,
      "jwt-1",
      new Date("2026-01-15T09:55:00Z"),
      new Date("2026-01-15T10:05:00Z"),
    );

    expect(points).toEqual([]);
  });
});

describe("fetchUnitRatesForDay", () => {
  it("fetches, normalizes, sorts, and drops the open-ended rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(ratesFixture)));

    const rates = await fetchUnitRatesForDay(testEnv, "2026-01-15");

    expect(rates).toEqual([
      { pencePerKwh: 21.0, validFrom: "2026-01-14T23:00:00Z", validTo: "2026-01-14T23:30:00Z" },
      { pencePerKwh: 23.1, validFrom: "2026-01-14T23:30:00Z", validTo: "2026-01-15T00:00:00Z" },
      { pencePerKwh: 18.9, validFrom: "2026-01-15T00:00:00Z", validTo: "2026-01-15T00:30:00Z" },
    ]);
  });

  it("caches the result so a second call doesn't refetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ratesFixture));
    vi.stubGlobal("fetch", fetchMock);

    await fetchUnitRatesForDay(testEnv, "2026-01-15");
    await fetchUnitRatesForDay(testEnv, "2026-01-15");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests the correct product/tariff path and UTC period bounds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ratesFixture));
    vi.stubGlobal("fetch", fetchMock);

    await fetchUnitRatesForDay(testEnv, "2026-01-15");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(
      "/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/",
    );
    expect(url).toContain(encodeURIComponent("2026-01-15T00:00:00.000Z"));
    expect(url).toContain(encodeURIComponent("2026-01-16T00:00:00.000Z"));
  });
});

describe("fetchStandingChargeForDay", () => {
  it("fetches and normalizes the standing charge in effect for the day", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(standingChargesFixture)));

    const pencePerDay = await fetchStandingChargeForDay(testEnv, "2026-01-15");

    expect(pencePerDay).toBe(47.25);
  });

  it("caches the result so a second call doesn't refetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(standingChargesFixture));
    vi.stubGlobal("fetch", fetchMock);

    await fetchStandingChargeForDay(testEnv, "2026-01-15");
    await fetchStandingChargeForDay(testEnv, "2026-01-15");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests the correct product/tariff path and UTC period bounds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(standingChargesFixture));
    vi.stubGlobal("fetch", fetchMock);

    await fetchStandingChargeForDay(testEnv, "2026-01-15");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(
      "/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standing-charges/",
    );
    expect(url).toContain(encodeURIComponent("2026-01-15T00:00:00.000Z"));
    expect(url).toContain(encodeURIComponent("2026-01-16T00:00:00.000Z"));
  });

  it("picks the entry whose validity window actually covers the requested day", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          count: 2,
          next: null,
          previous: null,
          results: [
            { value_exc_vat: 40, value_inc_vat: 42, valid_from: "2025-01-01T00:00:00Z", valid_to: "2026-01-15T00:00:00Z" },
            { value_exc_vat: 45, value_inc_vat: 47.25, valid_from: "2026-01-15T00:00:00Z", valid_to: null },
          ],
        }),
      ),
    );

    const pencePerDay = await fetchStandingChargeForDay(testEnv, "2026-01-15");

    expect(pencePerDay).toBe(47.25);
  });

  it("returns 0 when no standing charge is published for that day", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ count: 0, next: null, previous: null, results: [] })),
    );

    const pencePerDay = await fetchStandingChargeForDay(testEnv, "2026-01-15");

    expect(pencePerDay).toBe(0);
  });
});

describe("fetchPlannedDispatches", () => {
  it("normalizes Kraken's space-separated datetimes to ISO and sorts ascending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            plannedDispatches: [
              { startDt: "2026-08-23 00:00:00+00:00", endDt: "2026-08-23 00:30:00+00:00" },
              { startDt: "2026-08-22 21:02:49+00:00", endDt: "2026-08-23 01:24:26+00:00" },
            ],
          },
        }),
      ),
    );

    const dispatches = await fetchPlannedDispatches(testEnv, "jwt-1");

    expect(dispatches).toEqual([
      { start: "2026-08-22T21:02:49+00:00", end: "2026-08-23T01:24:26+00:00" },
      { start: "2026-08-23T00:00:00+00:00", end: "2026-08-23T00:30:00+00:00" },
    ]);
  });

  it("returns an empty array when the account has no planned dispatches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: { plannedDispatches: [] } })),
    );

    const dispatches = await fetchPlannedDispatches(testEnv, "jwt-1");

    expect(dispatches).toEqual([]);
  });

  it("sends the account number and JWT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { plannedDispatches: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPlannedDispatches(testEnv, "jwt-abc");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).variables).toEqual({ accountNumber: "A-TEST1234" });
    expect((init.headers as Record<string, string>).Authorization).toBe("JWT jwt-abc");
  });
});

describe("fetchHistoricalConsumption", () => {
  it("sorts intervals ascending by start time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(consumptionFixture)));

    const intervals = await fetchHistoricalConsumption(
      testEnv,
      new Date("2026-01-14T00:00:00Z"),
      new Date("2026-01-15T00:00:00Z"),
    );

    expect(intervals).toEqual([
      { consumptionKwh: 0.4, intervalStart: "2026-01-14T10:00:00Z" },
      { consumptionKwh: 0.6, intervalStart: "2026-01-14T10:30:00Z" },
      { consumptionKwh: 0.5, intervalStart: "2026-01-14T11:00:00Z" },
    ]);
  });

  it("authenticates with HTTP Basic Auth using the API key as username", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(consumptionFixture));
    vi.stubGlobal("fetch", fetchMock);

    await fetchHistoricalConsumption(
      testEnv,
      new Date("2026-01-14T00:00:00Z"),
      new Date("2026-01-15T00:00:00Z"),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/electricity-meter-points/1234567890123/meters/12A3456789/consumption/");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("sk_test_123:")}`,
    );
  });

  it("follows pagination via the next link", async () => {
    const page1 = { next: "https://api.octopus.energy/v1/next-page", results: consumptionFixture.results };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse({ next: null, results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const intervals = await fetchHistoricalConsumption(
      testEnv,
      new Date("2026-01-14T00:00:00Z"),
      new Date("2026-01-15T00:00:00Z"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(intervals).toHaveLength(3);
  });
});
