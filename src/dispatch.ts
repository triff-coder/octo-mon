import type { DispatchWindow } from "./octopus";
import type { UnitRate } from "./types";

/**
 * Intelligent Octopus prices smart-charging dispatches by half-hour slot:
 * any slot a dispatch touches is billed at the off-peak rate for the whole
 * household, even when it falls outside the tariff's normal off-peak hours
 * (e.g. the car charging at 22:00 when off-peak normally starts at 23:30).
 * The published standard-unit-rates know nothing about this, so this module
 * turns dispatch windows into a set of cheap slots and lays them over the
 * published rates.
 *
 * Slots are keyed by the ISO instant of their start. UK clock offsets are
 * whole hours, so 30-minute UTC boundaries are also 30-minute local ones.
 */
export const SLOT_MS = 30 * 60_000;

/**
 * Dispatches billed at the off-peak rate. Bump charges (a charge the
 * customer forces from the app) are billed at the normal rate; everything
 * else, including dispatches where Kraken didn't say what caused them, is
 * treated as an Octopus-scheduled smart charge.
 */
export function isOffPeakDispatch(dispatch: DispatchWindow): boolean {
  return dispatch.source !== "bump-charge";
}

export function slotStartMs(instantMs: number): number {
  return Math.floor(instantMs / SLOT_MS) * SLOT_MS;
}

/** Every half-hour slot a dispatch touches, by start instant. */
export function slotKeysForDispatch(dispatch: DispatchWindow): string[] {
  const startMs = new Date(dispatch.start).getTime();
  const endMs = new Date(dispatch.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const keys: string[] = [];
  for (let ms = slotStartMs(startMs); ms < endMs; ms += SLOT_MS) {
    keys.push(new Date(ms).toISOString());
  }
  return keys;
}

/** The cheapest rate published for a day — the tariff's off-peak rate. */
export function offPeakRate(rates: UnitRate[]): number | null {
  return rates.length === 0 ? null : Math.min(...rates.map((r) => r.pencePerKwh));
}

/**
 * Returns `rates` with every slot in `cheapSlots` repriced at the day's
 * off-peak rate. Splits published rate windows where a cheap slot starts or
 * ends, and merges neighbouring windows that end up at the same price (so a
 * dispatch running into the scheduled off-peak window reads as one cheap
 * window, and "current rate valid until" stays meaningful). Instants with no
 * published rate stay unpriced.
 */
export function overlayCheapSlots(rates: UnitRate[], cheapSlots: ReadonlySet<string>): UnitRate[] {
  const cheap = offPeakRate(rates);
  if (cheap === null || cheapSlots.size === 0) return rates;

  const result: UnitRate[] = [];
  for (const rate of rates) {
    const fromMs = new Date(rate.validFrom).getTime();
    const toMs = new Date(rate.validTo).getTime();

    let cursor = fromMs;
    while (cursor < toMs) {
      const slotEnd = Math.min(slotStartMs(cursor) + SLOT_MS, toMs);
      const pence = cheapSlots.has(new Date(slotStartMs(cursor)).toISOString()) ? cheap : rate.pencePerKwh;
      const last = result.at(-1);
      if (last && last.pencePerKwh === pence && new Date(last.validTo).getTime() === cursor) {
        last.validTo = new Date(slotEnd).toISOString();
      } else {
        result.push({
          pencePerKwh: pence,
          validFrom: new Date(cursor).toISOString(),
          validTo: new Date(slotEnd).toISOString(),
        });
      }
      cursor = slotEnd;
    }
  }
  return result;
}
