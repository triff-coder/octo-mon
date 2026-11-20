import { describe, expect, it } from "vitest";
import { isOffPeakDispatch, overlayCheapSlots, slotKeysForDispatch } from "../src/dispatch";
import type { UnitRate } from "../src/types";

describe("slotKeysForDispatch", () => {
  it("covers every half-hour slot the dispatch touches, rounding out to slot boundaries", () => {
    expect(slotKeysForDispatch({ start: "2026-01-19T22:02:49+00:00", end: "2026-01-19T23:00:01+00:00" })).toEqual([
      "2026-01-19T22:00:00.000Z",
      "2026-01-19T22:30:00.000Z",
      "2026-01-19T23:00:00.000Z",
    ]);
  });

  it("ignores an empty or inverted window", () => {
    expect(slotKeysForDispatch({ start: "2026-01-19T22:00:00Z", end: "2026-01-19T22:00:00Z" })).toEqual([]);
  });
});

describe("isOffPeakDispatch", () => {
  it("only treats smart charges (or dispatches with no source reported) as off-peak", () => {
    expect(isOffPeakDispatch({ start: "", end: "", source: "bump-charge" })).toBe(false);
    expect(isOffPeakDispatch({ start: "", end: "", source: "unknown" })).toBe(false);
    expect(isOffPeakDispatch({ start: "", end: "", source: "smart-charge" })).toBe(true);
    expect(isOffPeakDispatch({ start: "", end: "" })).toBe(true);
  });
});

describe("overlayCheapSlots", () => {
  const rates: UnitRate[] = [
    { pencePerKwh: 28, validFrom: "2026-01-19T05:30:00Z", validTo: "2026-01-19T23:30:00Z" },
    { pencePerKwh: 7, validFrom: "2026-01-19T23:30:00Z", validTo: "2026-01-20T05:30:00Z" },
  ];

  it("returns the published rates untouched when there are no cheap slots", () => {
    expect(overlayCheapSlots(rates, new Set())).toBe(rates);
  });

  it("reprices dispatch slots at the off-peak rate, merging into the scheduled off-peak window", () => {
    const slots = new Set(["2026-01-19T22:30:00.000Z", "2026-01-19T23:00:00.000Z"]);
    expect(overlayCheapSlots(rates, slots)).toEqual([
      { pencePerKwh: 28, validFrom: "2026-01-19T05:30:00.000Z", validTo: "2026-01-19T22:30:00.000Z" },
      { pencePerKwh: 7, validFrom: "2026-01-19T22:30:00.000Z", validTo: "2026-01-20T05:30:00.000Z" },
    ]);
  });

  it("splits a published window around a dispatch in the middle of it", () => {
    const slots = new Set(["2026-01-19T12:00:00.000Z"]);
    expect(overlayCheapSlots(rates, slots).slice(0, 3)).toEqual([
      { pencePerKwh: 28, validFrom: "2026-01-19T05:30:00.000Z", validTo: "2026-01-19T12:00:00.000Z" },
      { pencePerKwh: 7, validFrom: "2026-01-19T12:00:00.000Z", validTo: "2026-01-19T12:30:00.000Z" },
      { pencePerKwh: 28, validFrom: "2026-01-19T12:30:00.000Z", validTo: "2026-01-19T23:30:00.000Z" },
    ]);
  });
});
