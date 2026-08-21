import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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
});

const cachedStatus: StatusResponse = {
  generatedAt: new Date().toISOString(),
  currentRate: { pencePerKwh: 20, validFrom: "2026-01-15T10:00:00Z", validTo: "2026-01-15T10:30:00Z" },
  currentDemandKw: 1,
  currentCostPerHourGbp: 0.2,
  todayTotalKwh: 3,
  todayTotalCostGbp: 0.6,
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
});

describe("unknown routes", () => {
  it("returns 404 for other paths", async () => {
    const response = await callFetch(new Request("https://example.com/nope"));
    expect(response.status).toBe(404);
  });
});
