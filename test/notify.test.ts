import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeBonusSlots, notifyNewBonusSlots, NTFY_RETRY_DELAYS_MS } from "../src/notify";
import type { BonusSlot } from "../src/notify";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;

function slot(validFrom: string, validTo: string): BonusSlot {
  return { validFrom, validTo, pencePerKwh: 7, normalPencePerKwh: 34.7 };
}

const now = new Date("2026-11-20T18:00:00Z");
const evening = [
  slot("2026-11-20T20:00:00.000Z", "2026-11-20T20:30:00.000Z"),
  slot("2026-11-20T20:30:00.000Z", "2026-11-20T21:00:00.000Z"),
];

beforeEach(async () => {
  const list = await testEnv.OCTOMON_KV.list();
  await Promise.all(list.keys.map((k) => testEnv.OCTOMON_KV.delete(k.name)));
  testEnv.NTFY_TOPIC = "octo-test-topic";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete testEnv.NTFY_TOPIC;
});

describe("describeBonusSlots", () => {
  it("joins back-to-back slots into one line, in London time", () => {
    expect(describeBonusSlots(evening, now)).toBe("20:00–21:00 at 7.0p/kWh (normally 34.7p)");
  });

  it("marks slots on a later day and keeps separate runs on separate lines", () => {
    const slots = [evening[0]!, slot("2026-11-21T14:00:00.000Z", "2026-11-21T14:30:00.000Z")];
    expect(describeBonusSlots(slots, now)).toBe(
      "20:00–20:30 at 7.0p/kWh (normally 34.7p)\nTomorrow 14:00–14:30 at 7.0p/kWh (normally 34.7p)",
    );
  });
});

describe("notifyNewBonusSlots", () => {
  it("posts new slots to the ntfy topic once, not again on the next tick", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyNewBonusSlots(testEnv, evening, now);
    await notifyNewBonusSlots(testEnv, evening, new Date("2026-11-20T18:05:00Z"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh/octo-test-topic");
    expect(init.body).toBe("20:00–21:00 at 7.0p/kWh (normally 34.7p)");
  });

  it("announces only the slots it hasn't announced before when a dispatch is extended", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyNewBonusSlots(testEnv, evening, now);
    await notifyNewBonusSlots(
      testEnv,
      [...evening, slot("2026-11-20T21:00:00.000Z", "2026-11-20T21:30:00.000Z")],
      now,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].body).toBe("21:00–21:30 at 7.0p/kWh (normally 34.7p)");
  });

  it("retries a rate-limited push straight away rather than waiting for the next tick", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("limit reached", { status: 429 }))
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValueOnce(new Response("ok"));
      vi.stubGlobal("fetch", fetchMock);

      const done = notifyNewBonusSlots(testEnv, evening, now);
      await vi.advanceTimersByTimeAsync(NTFY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
      await done;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      await notifyNewBonusSlots(testEnv, evening, now);
      expect(fetchMock).toHaveBeenCalledTimes(3); // marked as announced
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't retry a push ntfy rejects outright, and says why", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("invalid topic", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(notifyNewBonusSlots(testEnv, evening, now)).rejects.toThrow("HTTP 400 invalid topic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on the next tick if the push keeps failing", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("nope", { status: 500 })));
      const failed = expect(notifyNewBonusSlots(testEnv, evening, now)).rejects.toThrow("HTTP 500 nope");
      await vi.advanceTimersByTimeAsync(NTFY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
      await failed;
    } finally {
      vi.useRealTimers();
    }

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await notifyNewBonusSlots(testEnv, evening, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a topic configured", async () => {
    delete testEnv.NTFY_TOPIC;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifyNewBonusSlots(testEnv, evening, now);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
