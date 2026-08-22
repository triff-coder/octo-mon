import { isAuthorized } from "./auth";
import {
  computeStatus,
  getOrComputeStatus,
  loadHourBuckets,
  loadMonthAccumulator,
  loadTodayAccumulator,
  persistComputedStatus,
} from "./compute";
import { renderDashboardHtml } from "./dashboard";
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
        const forceRefresh = url.searchParams.get("refresh") === "true";
        const status = await getOrComputeStatus(env, new Date(), forceRefresh);
        return jsonResponse(status, 200);
      } catch (error) {
        console.error("octo-mon /status failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse({ error: "internal_error", message }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      if (!isAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // The token that just authorized this request — embedded in the page
      // so its own client-side polling can call /status without asking again.
      const token = url.searchParams.get("token") ?? request.headers.get("X-Widget-Secret") ?? "";
      return new Response(renderDashboardHtml(token), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
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
