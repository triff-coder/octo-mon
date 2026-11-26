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
  /** Each announced slot's normal rate, so a cancellation can say what it's back to. */
  normalPence?: Record<string, number>;
}

/**
 * What Kraken currently says about dispatches, for spotting announced slots
 * that have since been dropped. Only passed when the planned-dispatch fetch
 * succeeded — a failed fetch says nothing about whether a slot is cancelled.
 */
export interface DispatchPlanSnapshot {
  /** Every slot Kraken still has (or had) at the off-peak rate: stored, planned and completed. */
  cheapSlotKeys: ReadonlySet<string>;
  /** Start of the next planned off-peak slot that hasn't started yet, if any. */
  nextCheapFrom: string | null;
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
 * One line per run of back-to-back cancelled slots, e.g.
 * "22:30–23:00 no longer cheap, back to 34.7p/kWh", plus when the next
 * cheap slot starts if one is planned.
 */
export function describeCancelledSlots(
  slotKeys: string[],
  normalPence: Record<string, number>,
  nextCheapFrom: string | null,
  now: Date,
): string {
  const sorted = [...slotKeys].sort();
  const runs: string[][] = [];
  for (const key of sorted) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run && last && new Date(last).getTime() + SLOT_MS === new Date(key).getTime() && normalPence[last] === normalPence[key]) {
      run.push(key);
    } else {
      runs.push([key]);
    }
  }

  const todayKey = londonDateKey(now);
  const dayPrefix = (d: Date) => (londonDateKey(d) === todayKey ? "" : "Tomorrow ");
  const lines = runs.map((run) => {
    const start = new Date(run[0]!);
    const end = new Date(new Date(run.at(-1)!).getTime() + SLOT_MS);
    const normal = normalPence[run[0]!];
    return (
      `${dayPrefix(start)}${timeFormat.format(start)}–${timeFormat.format(end)} no longer cheap` +
      (normal === undefined ? "" : `, back to ${formatPence(normal)}/kWh`)
    );
  });
  if (nextCheapFrom) {
    const next = new Date(nextCheapFrom);
    lines.push(`Next cheap slot starts ${dayPrefix(next)}${timeFormat.format(next)}`);
  }
  return lines.join("\n");
}

// ntfy.sh rate-limits by client IP, and Cloudflare Workers share egress IPs
// with everyone else's Workers, so a push can be refused (HTTP 429) for
// reasons that have nothing to do with this Worker. Smart-charge dispatches
// are often announced only minutes before they start, so waiting for the
// next cron tick can mean the slot is over before anyone hears about it —
// retry a couple of times within the tick first.
export const NTFY_RETRY_DELAYS_MS = [2_000, 5_000];

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function postToNtfy(topic: string, title: string, body: string): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= NTFY_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, NTFY_RETRY_DELAYS_MS[attempt - 1]));
    try {
      const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: { Title: title, Tags: "zap" },
        body,
      });
      if (response.ok) return;
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      lastError = new Error(`ntfy notification failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
      if (!isRetryableStatus(response.status)) break;
    } catch (error) {
      lastError = new Error(`ntfy notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError ?? new Error("ntfy notification failed");
}

async function saveNotified(env: Env, notified: Set<string>, normalPence: Record<string, number>): Promise<void> {
  const slots = [...notified].sort();
  const state: NotifiedState = {
    slots,
    normalPence: Object.fromEntries(slots.filter((k) => k in normalPence).map((k) => [k, normalPence[k]!])),
  };
  await putJson(env.OCTOMON_KV, NOTIFIED_KV_KEY, state, { expirationTtl: NOTIFIED_RETENTION_MS / 1000 });
}

/**
 * Sends push notifications (via ntfy — see the README) for bonus off-peak
 * slots not announced before, and — when `plan` is given — for announced
 * slots Octopus has since dropped before they finished (e.g. a dispatch
 * moved from 22:30 to 23:00 at the last minute). A cancelled slot is
 * forgotten, so it's announced again if Octopus puts it back. Does nothing
 * unless NTFY_TOPIC is set. State is only updated once a push succeeds, so
 * a failed push is retried a couple of times straight away and then again
 * on the next tick.
 *
 * Only call this from the cron tick: concurrent runs (a cron tick and an
 * on-demand refresh at the same moment) would each read the announced list
 * before the other saved it, and both send the same push.
 */
export async function notifyNewBonusSlots(
  env: Env,
  slots: BonusSlot[],
  now: Date,
  plan?: DispatchPlanSnapshot,
): Promise<void> {
  if (!env.NTFY_TOPIC) return;

  const nowMs = now.getTime();
  const cutoffMs = nowMs - NOTIFIED_RETENTION_MS;
  const stored = await getJson<NotifiedState>(env.OCTOMON_KV, NOTIFIED_KV_KEY);
  const notified = new Set((stored?.slots ?? []).filter((k) => new Date(k).getTime() >= cutoffMs));
  const normalPence: Record<string, number> = { ...(stored?.normalPence ?? {}) };

  if (plan) {
    const current = new Set(slots.map((s) => s.validFrom));
    const cancelled = [...notified].filter(
      (k) => new Date(k).getTime() + SLOT_MS > nowMs && !current.has(k) && !plan.cheapSlotKeys.has(k),
    );
    if (cancelled.length > 0) {
      await postToNtfy(
        env.NTFY_TOPIC,
        "Cheap electricity slot cancelled",
        describeCancelledSlots(cancelled, normalPence, plan.nextCheapFrom, now),
      );
      for (const k of cancelled) notified.delete(k);
      await saveNotified(env, notified, normalPence);
    }
  }

  const fresh = slots.filter((s) => !notified.has(s.validFrom) && new Date(s.validFrom).getTime() + SLOT_MS > nowMs);
  if (fresh.length === 0) return;

  await postToNtfy(env.NTFY_TOPIC, "Cheap electricity slot announced", describeBonusSlots(fresh, now));

  for (const slot of fresh) {
    notified.add(slot.validFrom);
    normalPence[slot.validFrom] = slot.normalPencePerKwh;
  }
  await saveNotified(env, notified, normalPence);
}
