import { isAuthorized } from "./auth";
import {
  computeStatus,
  getOrComputeStatus,
  loadHourBuckets,
  loadMonthAccumulator,
  loadTodayAccumulator,
  persistComputedStatus,
} from "./compute";
import type { Env } from "./types";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/status") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      try {
        const status = await getOrComputeStatus(env);
        return jsonResponse(status, 200);
      } catch (error) {
        console.error("octo-mon /status failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse({ error: "internal_error", message }, 500);
      }
    }

    return jsonResponse({ error: "not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const now = new Date();
      const previousAccumulator = await loadTodayAccumulator(env);
      const previousMonthAccumulator = await loadMonthAccumulator(env);
      const previousHourBuckets = await loadHourBuckets(env);
      const computed = await computeStatus(env, previousAccumulator, previousMonthAccumulator, previousHourBuckets, now);
      await persistComputedStatus(env, computed, now);
    } catch (error) {
      console.error("octo-mon cron tick failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
