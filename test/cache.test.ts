import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getJson, putJson } from "../src/cache";

interface Env {
  OCTOMON_KV: KVNamespace;
}

const testEnv = env as unknown as Env;

describe("cache", () => {
  beforeEach(async () => {
    const kv = testEnv.OCTOMON_KV;
    const list = await kv.list();
    await Promise.all(list.keys.map((k) => kv.delete(k.name)));
  });

  it("round-trips a JSON value", async () => {
    await putJson(testEnv.OCTOMON_KV, "widget", { a: 1, b: "two" });
    const value = await getJson<{ a: number; b: string }>(
      testEnv.OCTOMON_KV,
      "widget",
    );
    expect(value).toEqual({ a: 1, b: "two" });
  });

  it("returns null for a missing key", async () => {
    const value = await getJson(testEnv.OCTOMON_KV, "does-not-exist");
    expect(value).toBeNull();
  });

  it("clamps a too-short TTL up to KV's 60s minimum", async () => {
    // Not directly observable via the KV simulator's public API, but this at
    // least verifies the put doesn't throw KV's "TTL must be at least 60"
    // error for a caller that passes e.g. 5 seconds.
    await expect(
      putJson(testEnv.OCTOMON_KV, "short-lived", { ok: true }, { expirationTtl: 5 }),
    ).resolves.toBeUndefined();
  });
});
