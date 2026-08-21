import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth";
import type { Env } from "../src/types";

const env = { WIDGET_SHARED_SECRET: "correct-secret" } as Env;

describe("isAuthorized", () => {
  it("accepts the correct token via header", () => {
    const request = new Request("https://example.com/status", {
      headers: { "X-Widget-Secret": "correct-secret" },
    });
    expect(isAuthorized(request, env)).toBe(true);
  });

  it("accepts the correct token via query param", () => {
    const request = new Request("https://example.com/status?token=correct-secret");
    expect(isAuthorized(request, env)).toBe(true);
  });

  it("prefers the header over the query param when both are present", () => {
    const request = new Request("https://example.com/status?token=wrong", {
      headers: { "X-Widget-Secret": "correct-secret" },
    });
    expect(isAuthorized(request, env)).toBe(true);
  });

  it("rejects a wrong token", () => {
    const request = new Request("https://example.com/status", {
      headers: { "X-Widget-Secret": "nope" },
    });
    expect(isAuthorized(request, env)).toBe(false);
  });

  it("rejects when no token is provided", () => {
    const request = new Request("https://example.com/status");
    expect(isAuthorized(request, env)).toBe(false);
  });
});
