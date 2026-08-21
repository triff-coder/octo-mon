import type { Env } from "./types";

/**
 * Checks the widget's shared secret, accepted either as an `X-Widget-Secret`
 * header (preferred) or a `?token=` query param (handy for `curl` testing).
 * Uses a timing-safe comparison so response timing can't be used to guess
 * the secret byte by byte.
 */
export function isAuthorized(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const provided = request.headers.get("X-Widget-Secret") ?? url.searchParams.get("token");
  if (!provided) return false;

  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(env.WIDGET_SHARED_SECRET);
  if (a.byteLength !== b.byteLength) return false;

  return crypto.subtle.timingSafeEqual(a, b);
}
