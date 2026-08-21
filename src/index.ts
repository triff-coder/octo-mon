import { isAuthorized } from "./auth";
import { computeStatus, getOrComputeStatus, loadTodayAccumulator, persistComputedStatus } from "./compute";
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
      const status = await getOrComputeStatus(env);
      return jsonResponse(status, 200);
    }

    return jsonResponse({ error: "not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const now = new Date();
      const previousAccumulator = await loadTodayAccumulator(env);
      const computed = await computeStatus(env, previousAccumulator, now);
      await persistComputedStatus(env, computed, now);
    } catch (error) {
      console.error("octo-mon cron tick failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
