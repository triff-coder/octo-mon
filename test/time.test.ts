import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  billingPeriodKey,
  hourStartUtc,
  isSameBillingPeriod,
  isSameLondonDay,
  londonDateKey,
  londonMidnightUtc,
  minutesBetween,
  nextBillingPeriodStartUtc,
  nextLondonMidnightUtc,
  secondsBetween,
} from "../src/time";

describe("londonDateKey", () => {
  it("matches the UTC date in winter (GMT, no offset)", () => {
    expect(londonDateKey(new Date("2026-01-15T10:00:00Z"))).toBe("2026-01-15");
    expect(londonDateKey(new Date("2026-01-15T23:59:00Z"))).toBe("2026-01-15");
    expect(londonDateKey(new Date("2026-01-15T00:05:00Z"))).toBe("2026-01-15");
  });

  it("rolls to the next day before UTC midnight during BST", () => {
    // 23:30 UTC in June is 00:30 local (BST, UTC+1) the next day.
    expect(londonDateKey(new Date("2026-06-15T23:30:00Z"))).toBe("2026-06-16");
    expect(londonDateKey(new Date("2026-06-15T22:00:00Z"))).toBe("2026-06-15");
  });
});

describe("isSameLondonDay", () => {
  it("is true for instants on the same local day", () => {
    expect(
      isSameLondonDay(
        new Date("2026-06-15T22:00:00Z"),
        new Date("2026-06-15T22:30:00Z"),
      ),
    ).toBe(true);
  });

  it("is false across a local-day boundary caused by BST", () => {
    expect(
      isSameLondonDay(
        new Date("2026-06-15T22:00:00Z"),
        new Date("2026-06-15T23:30:00Z"),
      ),
    ).toBe(false);
  });
});

describe("minutesBetween / secondsBetween", () => {
  it("computes elapsed minutes and seconds", () => {
    const a = new Date("2026-01-15T10:00:00Z");
    const b = new Date("2026-01-15T10:05:30Z");
    expect(minutesBetween(a, b)).toBeCloseTo(5.5);
    expect(secondsBetween(a, b)).toBe(330);
  });

  it("can be negative when b precedes a", () => {
    const a = new Date("2026-01-15T10:05:00Z");
    const b = new Date("2026-01-15T10:00:00Z");
    expect(minutesBetween(a, b)).toBeCloseTo(-5);
  });
});

describe("nextLondonMidnightUtc", () => {
  it("returns the following UTC midnight during GMT (no offset)", () => {
    const instant = new Date("2026-01-15T10:00:00Z");
    expect(nextLondonMidnightUtc(instant).toISOString()).toBe(
      "2026-01-16T00:00:00.000Z",
    );
  });

  it("returns 23:00 UTC during BST (local midnight is UTC+1)", () => {
    const instant = new Date("2026-06-15T10:00:00Z");
    expect(nextLondonMidnightUtc(instant).toISOString()).toBe(
      "2026-06-15T23:00:00.000Z",
    );
  });

  it("handles the spring-forward transition day (23-hour local day)", () => {
    // BST begins 2026-03-29T01:00:00Z. Before the transition, offset is
    // still 0, so the next local midnight (start of the 23-hour day) is a
    // plain UTC midnight.
    const beforeTransition = new Date("2026-03-28T10:00:00Z");
    expect(nextLondonMidnightUtc(beforeTransition).toISOString()).toBe(
      "2026-03-29T00:00:00.000Z",
    );

    // After the transition, offset is +60, so local midnight of the next
    // day lands at 23:00 UTC the same UTC-calendar day.
    const afterTransition = new Date("2026-03-29T10:00:00Z");
    expect(nextLondonMidnightUtc(afterTransition).toISOString()).toBe(
      "2026-03-29T23:00:00.000Z",
    );
  });

  it("handles the autumn clock-back transition day (25-hour local day)", () => {
    // BST ends 2026-10-25T01:00:00Z. Before that, offset is still +60, so
    // local midnight of Oct 25 lands at 23:00 UTC on Oct 24.
    const beforeTransition = new Date("2026-10-24T10:00:00Z");
    expect(nextLondonMidnightUtc(beforeTransition).toISOString()).toBe(
      "2026-10-24T23:00:00.000Z",
    );

    // After the transition (back to GMT), local midnight of Oct 26 is a
    // plain UTC midnight again.
    const afterTransition = new Date("2026-10-25T10:00:00Z");
    expect(nextLondonMidnightUtc(afterTransition).toISOString()).toBe(
      "2026-10-26T00:00:00.000Z",
    );
  });
});

describe("billingPeriodKey", () => {
  it("stays in the current month on or after the 20th", () => {
    expect(billingPeriodKey(new Date("2026-08-20T10:00:00Z"))).toBe("2026-08-20");
    expect(billingPeriodKey(new Date("2026-08-31T23:00:00Z"))).toBe("2026-08-20");
  });

  it("rolls back to the previous month's 20th before the 20th", () => {
    // 20:00 UTC in August is 21:00 local (BST), still 19 August.
    expect(billingPeriodKey(new Date("2026-08-19T20:00:00Z"))).toBe("2026-07-20");
    expect(billingPeriodKey(new Date("2026-08-01T00:00:00Z"))).toBe("2026-07-20");
  });

  it("handles the January/December year rollover", () => {
    expect(billingPeriodKey(new Date("2026-01-10T00:00:00Z"))).toBe("2025-12-20");
    expect(billingPeriodKey(new Date("2026-12-25T00:00:00Z"))).toBe("2026-12-20");
  });
});

describe("isSameBillingPeriod", () => {
  it("is true within the same billing period", () => {
    // 00:00 UTC on 20 Aug is 01:00 local (BST); 22:00 UTC on 19 Sep is 23:00
    // local (BST) — both fall within the [20 Aug, 20 Sep) billing period.
    expect(
      isSameBillingPeriod(new Date("2026-08-20T00:00:00Z"), new Date("2026-09-19T22:00:00Z")),
    ).toBe(true);
  });

  it("is false across a billing period boundary", () => {
    expect(
      isSameBillingPeriod(new Date("2026-08-19T22:00:00Z"), new Date("2026-08-19T23:30:00Z")),
    ).toBe(false);
  });
});

describe("nextBillingPeriodStartUtc", () => {
  it("returns the UTC instant of the 20th of the following month", () => {
    expect(nextBillingPeriodStartUtc(new Date("2026-08-25T10:00:00Z")).toISOString()).toBe(
      "2026-09-19T23:00:00.000Z", // 20 Sep 2026 local (BST, UTC+1)
    );
  });

  it("rolls over the year in December", () => {
    expect(nextBillingPeriodStartUtc(new Date("2026-12-25T10:00:00Z")).toISOString()).toBe(
      "2027-01-20T00:00:00.000Z",
    );
  });
});

describe("hourStartUtc", () => {
  it("truncates to the start of the containing UTC clock hour", () => {
    expect(hourStartUtc(new Date("2026-01-15T10:00:00Z")).toISOString()).toBe(
      "2026-01-15T10:00:00.000Z",
    );
    expect(hourStartUtc(new Date("2026-01-15T10:59:59.999Z")).toISOString()).toBe(
      "2026-01-15T10:00:00.000Z",
    );
    expect(hourStartUtc(new Date("2026-01-15T10:00:00.001Z")).toISOString()).toBe(
      "2026-01-15T10:00:00.000Z",
    );
  });

  it("is a plain UTC boundary, unaffected by BST", () => {
    // Distinguishes it from a London-local hour bucket: 23:30 BST-local
    // still truncates to a UTC hour boundary, not a local one.
    expect(hourStartUtc(new Date("2026-06-15T22:30:00Z")).toISOString()).toBe(
      "2026-06-15T22:00:00.000Z",
    );
  });
});

describe("londonMidnightUtc / addDaysToDateKey", () => {
  it("computes the UTC instant of local midnight for a given date key", () => {
    expect(londonMidnightUtc("2026-01-15").toISOString()).toBe(
      "2026-01-15T00:00:00.000Z",
    );
    expect(londonMidnightUtc("2026-06-15").toISOString()).toBe(
      "2026-06-14T23:00:00.000Z",
    );
  });

  it("adds days across a month/year boundary", () => {
    expect(addDaysToDateKey("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });
});
