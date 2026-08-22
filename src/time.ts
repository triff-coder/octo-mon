const LONDON_TZ = "Europe/London";

const londonDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: LONDON_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const londonClockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: LONDON_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Europe/London calendar date (YYYY-MM-DD) for the given UTC instant. */
export function londonDateKey(instant: Date): string {
  return londonDateKeyFormatter.format(instant);
}

/** Whether two instants fall on the same Europe/London calendar day. */
export function isSameLondonDay(a: Date, b: Date): boolean {
  return londonDateKey(a) === londonDateKey(b);
}

/** Minutes between the elapsed time from `a` to `b` (may be negative). */
export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

/** Whole seconds elapsed from `a` to `b` (may be negative). */
export function secondsBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 1000);
}

/**
 * The UTC instant at the start of the clock hour containing `instant`
 * (plain UTC truncation — hour buckets are a fixed-width UTC grid, not a
 * Europe/London local concept, so no DST handling is needed here).
 */
export function hourStartUtc(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / 3_600_000) * 3_600_000);
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The Europe/London UTC offset (in minutes) in effect at `instant`
 * (0 during GMT, 60 during BST).
 */
function londonOffsetMinutes(instant: Date): number {
  const parts = Object.fromEntries(
    londonClockFormatter.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * The UTC instant corresponding to 00:00 local time on the given
 * Europe/London calendar date. Resolves the correct UTC/BST offset with a
 * two-pass correction so it stays accurate across clock-change days.
 */
export function londonMidnightUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const utcMidnightGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const firstPassOffset = londonOffsetMinutes(new Date(utcMidnightGuess));
  const candidate = utcMidnightGuess - firstPassOffset * 60_000;
  const secondPassOffset = londonOffsetMinutes(new Date(candidate));
  return new Date(utcMidnightGuess - secondPassOffset * 60_000);
}

/**
 * The next Europe/London local midnight strictly after `instant`, i.e. the
 * start of the following local day. Used to size KV expiry / detect when a
 * "today" accumulator needs to roll over.
 */
export function nextLondonMidnightUtc(instant: Date): Date {
  const tomorrowKey = addDaysToDateKey(londonDateKey(instant), 1);
  return londonMidnightUtc(tomorrowKey);
}

/**
 * The Europe/London date key (YYYY-MM-DD) for the start of the Octopus
 * billing period containing `instant`. Billing months run from
 * `billingDay` of one calendar month to `billingDay - 1` of the next.
 */
export function billingPeriodKey(instant: Date, billingDay = 20): string {
  const [y, m, d] = londonDateKey(instant).split("-").map(Number) as [number, number, number];
  if (d >= billingDay) {
    return `${y}-${String(m).padStart(2, "0")}-${String(billingDay).padStart(2, "0")}`;
  }
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(billingDay).padStart(2, "0")}`;
}

/** Whether two instants fall in the same Octopus billing period (see billingPeriodKey). */
export function isSameBillingPeriod(a: Date, b: Date, billingDay = 20): boolean {
  return billingPeriodKey(a, billingDay) === billingPeriodKey(b, billingDay);
}

/**
 * The UTC instant at which the billing period containing `instant` ends
 * (i.e. the start, in Europe/London local time, of the following billing
 * period). Used to size KV expiry for the monthly accumulator.
 */
export function nextBillingPeriodStartUtc(instant: Date, billingDay = 20): Date {
  const [y, m] = billingPeriodKey(instant, billingDay).split("-").map(Number) as [number, number, number];
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const nextPeriodKey = `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(billingDay).padStart(2, "0")}`;
  return londonMidnightUtc(nextPeriodKey);
}
