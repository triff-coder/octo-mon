import { getJson, putJson } from "./cache";
import { SLOT_MS } from "./dispatch";
import { londonDateKey } from "./time";
import type { Env } from "./types";

/** A half-hour slot Octopus has scheduled at the off-peak rate that would normally be dearer. */
export interface BonusSlot {
  validFrom: string;
  validTo: string;
  pencePerKwh: number;
  normalPencePerKwh: number;
}

// Slots already notified about, by start instant, so each one is announced
// once however many cron ticks see it.
const NOTIFIED_KV_KEY = "dispatch:notified";
const NOTIFIED_RETENTION_MS = 2 * 86_400_000;

interface NotifiedState {
  slots: string[];
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatPence(pence: number): string {
  return `${pence.toFixed(1)}p`;
}

/** One line per run of back-to-back slots, e.g. "20:00–21:30 at 7.0p/kWh (normally 34.7p)". */
export function describeBonusSlots(slots: BonusSlot[], now: Date): string {
  const sorted = [...slots].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const runs: BonusSlot[][] = [];
  for (const slot of sorted) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (
      run &&
      last &&
      new Date(last.validTo).getTime() === new Date(slot.validFrom).getTime() &&
      last.pencePerKwh === slot.pencePerKwh &&
      last.normalPencePerKwh === slot.normalPencePerKwh
    ) {
      run.push(slot);
    } else {
      runs.push([slot]);
    }
  }

  const todayKey = londonDateKey(now);
  return runs
    .map((run) => {
      const start = new Date(run[0]!.validFrom);
      const end = new Date(run.at(-1)!.validTo);
      const day = londonDateKey(start) === todayKey ? "" : "Tomorrow ";
      return (
        `${day}${timeFormat.format(start)}–${timeFormat.format(end)} at ${formatPence(run[0]!.pencePerKwh)}/kWh` +
        ` (normally ${formatPence(run[0]!.normalPencePerKwh)})`
      );
    })
    .join("\n");
}

/**
 * Sends a push notification (via ntfy — see the README) for any bonus
 * off-peak slots not announced before. Does nothing unless NTFY_TOPIC is
 * set. A slot is only marked as announced once the push succeeds, so a
 * failed push is retried on the next tick.
 */
export async function notifyNewBonusSlots(env: Env, slots: BonusSlot[], now: Date): Promise<void> {
  if (!env.NTFY_TOPIC) return;

  const cutoffMs = now.getTime() - NOTIFIED_RETENTION_MS;
  const stored = (await getJson<NotifiedState>(env.OCTOMON_KV, NOTIFIED_KV_KEY))?.slots ?? [];
  const notified = new Set(stored.filter((k) => new Date(k).getTime() >= cutoffMs));

  const fresh = slots.filter(
    (s) => !notified.has(s.validFrom) && new Date(s.validFrom).getTime() + SLOT_MS > now.getTime(),
  );
  if (fresh.length === 0) return;

  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: "POST",
    headers: { Title: "Cheap electricity slot announced", Tags: "zap" },
    body: describeBonusSlots(fresh, now),
  });
  if (!response.ok) {
    throw new Error(`ntfy notification failed: HTTP ${response.status}`);
  }

  for (const slot of fresh) notified.add(slot.validFrom);
  const state: NotifiedState = { slots: [...notified].sort() };
  await putJson(env.OCTOMON_KV, NOTIFIED_KV_KEY, state, { expirationTtl: NOTIFIED_RETENTION_MS / 1000 });
}
