/**
 * Unit tests for the requestContext middleware.
 * Test library/framework: Vitest
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("@sentry/node", () => ({
  setAttributes: vi.fn(),
  setTag: vi.fn(),
  // `requestContext` pulls in the logger, which asks whether the SDK is live.
  isEnabled: () => false,
  createSentryWinstonTransport: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import { requestContext } from "../../middleware/requestContext.js";
import { logger } from "../../middleware/logger.js";
import { getRequestContext, updateRequestContext } from "../../utils/requestStore.js";

const UUID_A = "6f1b3c2e-1d4a-4b7e-9c2f-0a1b2c3d4e5f";
const UUID_B = "9a8b7c6d-5e4f-4a3b-8c9d-1e2f3a4b5c6d";

const makeReqResNext = (
  headers: Record<string, string> = {},
  overrides: Partial<{ path: string; query: Record<string, unknown> }> = {}
) => {
  const req = {
    headers,
    method: "POST",
    path: overrides.path ?? "/api/vacation/123",
    baseUrl: "/api/vacation",
    query: overrides.query ?? {},
  } as unknown as Request;
  const res = { setHeader: vi.fn() } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
};

describe("requestContext middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, "info").mockImplementation(() => logger);
  });

  it("generates a request id when none arrives and echoes it on the response", () => {
    const { req, res, next } = makeReqResNext();
    let seen: string | undefined;
    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      seen = getRequestContext()?.requestId;
    });

    requestContext(req, res, next);

    expect(seen).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.setHeader).toHaveBeenCalledWith("x-request-id", seen);
  });

  it("reuses an inbound x-request-id so a proxy's id stays the correlation key", () => {
    const { req, res, next } = makeReqResNext({ "x-request-id": "edge-abc.123:1" });
    let seen: string | undefined;
    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      seen = getRequestContext()?.requestId;
    });

    requestContext(req, res, next);

    expect(seen).toBe("edge-abc.123:1");
    expect(res.setHeader).toHaveBeenCalledWith("x-request-id", "edge-abc.123:1");
  });

  it("replaces an inbound x-request-id that is not a safe token", () => {
    const { req, res, next } = makeReqResNext({ "x-request-id": "bad id\nwith newline" });
    let seen: string | undefined;
    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      seen = getRequestContext()?.requestId;
    });

    requestContext(req, res, next);

    expect(seen).not.toBe("bad id\nwith newline");
    expect(seen).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("exposes the request details and client ids to downstream handlers", () => {
    const { req, res, next } = makeReqResNext({
      "x-client-session-id": UUID_A,
      "x-client-device-id": UUID_B,
      "user-agent": "Mozilla/5.0",
    });
    let ctx: ReturnType<typeof getRequestContext>;
    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      ctx = getRequestContext();
    });

    requestContext(req, res, next);

    expect(ctx).toMatchObject({
      clientSessionId: UUID_A,
      clientDeviceId: UUID_B,
      method: "POST",
      path: "/api/vacation/123",
      userAgent: "Mozilla/5.0",
    });
  });

  it("drops client ids that are not UUID-shaped rather than logging attacker input", () => {
    const { req, res, next } = makeReqResNext({
      "x-client-session-id": "'; DROP TABLE user; --",
      "x-client-device-id": "x".repeat(500),
    });
    let ctx: ReturnType<typeof getRequestContext>;
    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      ctx = getRequestContext();
    });

    requestContext(req, res, next);

    expect(ctx?.clientSessionId).toBeUndefined();
    expect(ctx?.clientDeviceId).toBeUndefined();
    expect(Sentry.setTag).not.toHaveBeenCalledWith("client_session_id", expect.anything());
  });

  it("registers Sentry attributes and tags for the request", () => {
    const { req, res, next } = makeReqResNext({ "x-client-session-id": UUID_A });

    requestContext(req, res, next);

    expect(Sentry.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "http.request.method": "POST",
        "url.path": "/api/vacation/123",
        "client.session_id": UUID_A,
      })
    );
    expect(Sentry.setTag).toHaveBeenCalledWith("request_id", expect.any(String));
    expect(Sentry.setTag).toHaveBeenCalledWith("client_session_id", UUID_A);
  });

  it("keeps context isolated per request", () => {
    const first = makeReqResNext({ "x-request-id": "req-1" });
    const second = makeReqResNext({ "x-request-id": "req-2" });
    const seen: string[] = [];
    const record = () => {
      const id = getRequestContext()?.requestId;
      if (id) seen.push(id);
    };

    (first.next as unknown as ReturnType<typeof vi.fn>).mockImplementation(record);
    (second.next as unknown as ReturnType<typeof vi.fn>).mockImplementation(record);

    requestContext(first.req, first.res, first.next);
    requestContext(second.req, second.res, second.next);

    expect(seen).toEqual(["req-1", "req-2"]);
    // Outside any request the store is empty — nothing leaks between requests.
    expect(getRequestContext()).toBeUndefined();
  });

  it("lets later middleware add to the context (userId from authSession)", () => {
    const { req, res, next } = makeReqResNext();
    let ctx: ReturnType<typeof getRequestContext>;
    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      updateRequestContext({ userId: "user_1" });
      ctx = getRequestContext();
    });

    requestContext(req, res, next);

    expect(ctx?.userId).toBe("user_1");
  });
});

describe("requestContext request logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, "info").mockImplementation(() => logger);
  });

  it("logs one line per incoming request", () => {
    const { req, res, next } = makeReqResNext();

    requestContext(req, res, next);

    expect(logger.info).toHaveBeenCalledWith("POST /api/vacation/123", {
      "http.event": "request",
    });
  });

  it("puts the query string on the context and the Sentry attributes", () => {
    const { req, res, next } = makeReqResNext({}, { query: { year: "2026", month: "8" } });
    let ctx: ReturnType<typeof getRequestContext>;
    (next as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      ctx = getRequestContext();
    });

    requestContext(req, res, next);

    expect(ctx?.query).toBe("year=2026&month=8");
    expect(Sentry.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "url.query": "year=2026&month=8" })
    );
  });

  it("never logs the calendar feed token or a verification token", () => {
    const { req, res, next } = makeReqResNext(
      {},
      { path: "/calendars/super-secret-token.ics", query: { token: "another-secret" } }
    );

    requestContext(req, res, next);

    const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
    const attributes = JSON.stringify(vi.mocked(Sentry.setAttributes).mock.calls);
    expect(logged).not.toContain("super-secret-token");
    expect(attributes).not.toContain("super-secret-token");
    expect(attributes).not.toContain("another-secret");
    expect(logged).toContain("/calendars/:token.ics");
  });

  it("skips paths listed in REQUEST_LOG_IGNORE_PATHS", async () => {
    vi.resetModules();
    process.env.REQUEST_LOG_IGNORE_PATHS = "/health";
    const { requestContext: freshMiddleware } = await import(
      "../../middleware/requestContext.js?ignore-paths"
    );
    const { logger: freshLogger } = await import("../../middleware/logger.js?ignore-paths");
    const infoSpy = vi.spyOn(freshLogger, "info").mockImplementation(() => freshLogger);

    const { req, res, next } = makeReqResNext({}, { path: "/health" });
    freshMiddleware(req, res, next);

    expect(infoSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    delete process.env.REQUEST_LOG_IGNORE_PATHS;
  });
});
