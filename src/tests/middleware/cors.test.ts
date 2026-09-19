/**
 * The CORS preflight allowlist. Test library/framework: Vitest
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Request, Response } from "express";

/** The allowlist is built at import, so each environment needs a fresh graph. */
const preflight = async (env: "dev" | "production", origin: string) => {
  vi.resetModules();
  vi.doMock("../../config.js", () => ({
    config: {
      api: { env },
      trustedOrigins: ["https://app.flexi-day.com", "flexiday://"],
    },
  }));
  const { serverCors } = await import("../../middleware/cors.js");

  const headers: Record<string, string> = {};
  const req = {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  } as unknown as Request;
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = String(value);
    },
    getHeader: () => undefined,
    end: vi.fn(),
  } as unknown as Response;

  serverCors(req, res, () => {});

  return headers;
};

const allowedHeaders = async (env: "dev" | "production", origin: string) =>
  (await preflight(env, origin))["access-control-allow-headers"] ?? "";

describe("serverCors allowed headers", () => {
  afterEach(() => {
    vi.doUnmock("../../config.js");
    vi.resetModules();
  });

  it("accepts the phone app's headers outside production", async () => {
    const allowed = await allowedHeaders("dev", "http://localhost:3000");

    expect(allowed).toContain("x-client-device-id");
    expect(allowed).toContain("x-client-platform");
    expect(allowed).toContain("x-client-app-version");
  });

  it("accepts the phone app's headers in production too", async () => {
    const allowed = await allowedHeaders("production", "https://app.flexi-day.com");

    expect(allowed).toContain("x-client-device-id");
    expect(allowed).toContain("x-client-platform");
    expect(allowed).toContain("x-client-app-version");
    // The dev sign-in token stays out of the production allowlist.
    expect(allowed).not.toContain("x-dev-token");
  });

  it("keeps the app's URL scheme out of the production origin allowlist", async () => {
    const browser = await preflight("production", "https://app.flexi-day.com");
    expect(browser["access-control-allow-origin"]).toBe("https://app.flexi-day.com");

    const nativeScheme = await preflight("production", "flexiday://");
    expect(nativeScheme["access-control-allow-origin"]).toBeUndefined();
  });
});
