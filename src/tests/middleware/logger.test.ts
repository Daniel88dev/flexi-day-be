/**
 * Unit tests for the logger's context/error formats.
 * Test library/framework: Vitest
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import TransportStream from "winston-transport";

import { logger } from "../../middleware/logger.js";
import { runWithRequestContext } from "../../utils/requestStore.js";

type Entry = Record<string, unknown>;

const captured: Entry[] = [];

class CaptureTransport extends TransportStream {
  log(info: Entry, callback: () => void) {
    captured.push(info);
    callback();
  }
}

logger.add(new CaptureTransport());

const lastEntry = (): Entry => {
  const entry = captured.at(-1);
  if (!entry) throw new Error("nothing was logged");
  return entry;
};

describe("logger request context format", () => {
  beforeEach(() => {
    captured.length = 0;
    vi.restoreAllMocks();
  });

  it("stamps the active request's correlation ids onto every entry", () => {
    runWithRequestContext(
      {
        requestId: "req-1",
        clientSessionId: "sess-1",
        clientDeviceId: "dev-1",
        method: "POST",
        path: "/api/vacation",
        userId: "user_1",
      },
      () => logger.info("booked")
    );

    expect(lastEntry()).toMatchObject({
      message: "booked",
      "request.id": "req-1",
      "client.session_id": "sess-1",
      "client.device_id": "dev-1",
      "http.request.method": "POST",
      "url.path": "/api/vacation",
      "user.id": "user_1",
    });
  });

  it("logs fine outside a request (jobs, startup)", () => {
    logger.info("Quota rollover job scheduled");

    expect(lastEntry()).toMatchObject({ message: "Quota rollover job scheduled" });
    expect(lastEntry()["request.id"]).toBeUndefined();
  });

  it("omits optional context fields that were never set", () => {
    runWithRequestContext({ requestId: "req-2", method: "GET", path: "/health" }, () =>
      logger.info("ok")
    );

    const entry = lastEntry();
    expect(entry["request.id"]).toBe("req-2");
    expect(entry).not.toHaveProperty("user.id");
    expect(entry).not.toHaveProperty("client.session_id");
  });
});

describe("logger error serializer format", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("flattens an Error into indexable fields instead of the `{}` JSON gives", () => {
    const boom = new Error("connection refused");

    logger.error("notifyVacationRequested failed", { error: boom, requesterId: "user_1" });

    const entry = lastEntry();
    expect(entry["error.name"]).toBe("Error");
    expect(entry["error.message"]).toBe("connection refused");
    expect(entry["error.stack"]).toContain("connection refused");
    expect(entry.error).toBeUndefined();
    expect(entry.requesterId).toBe("user_1");
  });

  it("keeps the cause of a wrapped error", () => {
    const wrapped = new Error("send failed", { cause: new Error("SES throttled") });

    logger.error("Failed to send verification email", { error: wrapped });

    expect(lastEntry()["error.cause"]).toBe("SES throttled");
  });

  it("leaves non-Error meta alone", () => {
    logger.warn("devGuard rejected non-loopback request", { peer: "10.0.0.1", path: "/api/dev" });

    expect(lastEntry()).toMatchObject({ peer: "10.0.0.1", path: "/api/dev" });
  });
});
