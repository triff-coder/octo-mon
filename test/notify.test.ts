import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeBonusSlots, describeCancelledSlots, notifyNewBonusSlots, NTFY_RETRY_DELAYS_MS } from "../src/notify";
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

describe("describeCancelledSlots", () => {
  it("says what the rate is back to and when the next cheap slot starts", () => {
    expect(
      describeCancelledSlots(
        ["2026-11-26T22:30:00.000Z"],
        { "2026-11-26T22:30:00.000Z": 34.7 },
        "2026-11-26T23:00:00.000Z",
        new Date("2026-11-26T22:30:00Z"),
      ),
    ).toBe("22:30–23:00 no longer cheap, back to 34.7p/kWh\nNext cheap slot starts 23:00");
  });

  it("copes with slots announced before normal rates were remembered", () => {
    expect(describeCancelledSlots(["2026-11-20T20:00:00.000Z", "2026-11-20T20:30:00.000Z"], {}, null, now)).toBe(
      "20:00–21:00 no longer cheap",
    );
  });
});

describe("notifyNewBonusSlots cancellations", () => {
  const s2230 = slot("2026-11-26T22:30:00.000Z", "2026-11-26T23:00:00.000Z");
  const s2300 = slot("2026-11-26T23:00:00.000Z", "2026-11-26T23:30:00.000Z");
  const plan = (keys: string[], nextCheapFrom: string | null = null) => ({ cheapSlotKeys: new Set(keys), nextCheapFrom });

  it("says so when Octopus moves an announced dispatch later before it starts (26 Nov 22:30)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    // 21:30: dispatch planned from 22:30.
    await notifyNewBonusSlots(testEnv, [s2230, s2300], new Date("2026-11-26T21:30:00Z"), plan([s2230.validFrom, s2300.validFrom]));
    // 22:30: Kraken now plans it from 23:00 instead.
    const at2230 = new Date("2026-11-26T22:30:20Z");
    await notifyNewBonusSlots(testEnv, [s2300], at2230, plan([s2300.validFrom], s2300.validFrom));
    // And nothing more on the next tick.
    await notifyNewBonusSlots(testEnv, [s2300], new Date("2026-11-26T22:35:00Z"), plan([s2300.validFrom], s2300.validFrom));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Title).toBe("Cheap electricity slot cancelled");
    expect(init.body).toBe("22:30–23:00 no longer cheap, back to 34.7p/kWh\nNext cheap slot starts 23:00");
  });

  it("announces a cancelled slot again if Octopus puts it back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyNewBonusSlots(testEnv, [s2230], new Date("2026-11-26T21:30:00Z"), plan([s2230.validFrom]));
    await notifyNewBonusSlots(testEnv, [], new Date("2026-11-26T21:35:00Z"), plan([]));
    await notifyNewBonusSlots(testEnv, [s2230], new Date("2026-11-26T21:40:00Z"), plan([s2230.validFrom]));

    expect(fetchMock.mock.calls.map((c) => (c as [string, RequestInit])[1].body)).toEqual([
      "22:30–23:00 at 7.0p/kWh (normally 34.7p)",
      "22:30–23:00 no longer cheap, back to 34.7p/kWh",
      "22:30–23:00 at 7.0p/kWh (normally 34.7p)",
    ]);
  });

  it("doesn't call a slot cancelled without a trustworthy plan, once it's over, or when Kraken still counts it cheap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyNewBonusSlots(testEnv, [s2230], new Date("2026-11-26T21:30:00Z"), plan([s2230.validFrom]));
    // plannedDispatches failed this tick: no plan passed.
    await notifyNewBonusSlots(testEnv, [], new Date("2026-11-26T21:35:00Z"));
    // Still listed as cheap (e.g. moved to completed dispatches).
    await notifyNewBonusSlots(testEnv, [], new Date("2026-11-26T22:45:00Z"), plan([s2230.validFrom]));
    // Slot already finished.
    await notifyNewBonusSlots(testEnv, [], new Date("2026-11-26T23:00:00Z"), plan([]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
