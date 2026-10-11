import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  calendarCapability,
  calendarProvider,
} from "../../../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../../../db/schema/vacation-schema.js";
import { ProviderGrantRevokedError } from "../../../calendarConnection/providers/types.js";
import { createGoogleDriver } from "../googleDriver.js";
import { context, countingTokens, desired } from "./context.js";
import { startFakeApi, type FakeApi } from "./fakeApi.js";

let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.requests.length = 0;
});

const driver = () => createGoogleDriver({ rootUrl: `${api.url}/` });
const g = calendarProvider.Google;
const EVENTS = "/calendar/v3/calendars/primary/events";

const googleError = (status: number, reason: string, message = "token ya29.secret") => ({
  error: { code: status, message, errors: [{ domain: "calendar", reason, message }] },
});

describe("Google driver, writes", () => {
  it("inserts the event on the primary calendar and returns its id", async () => {
    api.answer(() => ({ status: 200, body: { id: "evt-1" } }));
    const event = desired(g);

    const result = await driver().insert(context(g), event);

    expect(result).toEqual({ ok: true, providerEventId: "evt-1" });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.method).toBe("POST");
    expect(api.requests[0]?.path).toBe(EVENTS);
    expect(api.requests[0]?.headers.authorization).toBe("Bearer token-1");
    expect(api.requests[0]?.body).toEqual(event.payload);
  });

  it("patches the event by id", async () => {
    api.answer(() => ({ status: 200, body: { id: "evt-1" } }));

    const result = await driver().patch(context(g), "evt-1", desired(g));

    expect(result).toEqual({ ok: true, providerEventId: "evt-1" });
    expect(api.requests[0]?.method).toBe("PATCH");
    expect(api.requests[0]?.path).toBe(`${EVENTS}/evt-1`);
  });

  it("deletes the event by id", async () => {
    api.answer(() => ({ status: 204 }));

    expect(await driver().delete(context(g), "evt-1")).toEqual({ ok: true });
    expect(api.requests[0]?.method).toBe("DELETE");
    expect(api.requests[0]?.path).toBe(`${EVENTS}/evt-1`);
  });
});

describe("Google driver, failures", () => {
  it.each([
    ["malformedWorkingLocationEvent", CalendarRecordType.Vacation],
    ["malformedOutOfOfficeEvent", CalendarRecordType.Sick],
  ])("maps a 400 %s to capability_refused with the reason", async (reason, type) => {
    api.answer(() => ({ status: 400, body: googleError(400, reason) }));

    const result = await driver().insert(context(g), desired(g, calendarCapability.Unknown, type));

    expect(result).toEqual({ ok: false, error: "capability_refused", reason });
    expect(JSON.stringify(result)).not.toContain("ya29");
  });

  it("maps an invalid_grant at the token endpoint to auth_revoked", async () => {
    const revoked = () => Promise.reject(new ProviderGrantRevokedError("invalid_grant"));

    expect(await driver().insert(context(g, revoked), desired(g))).toEqual({
      ok: false,
      error: "auth_revoked",
      reason: "invalid_grant",
    });
    expect(api.requests).toHaveLength(0);
  });

  it("refreshes once on 401 and then reports auth_revoked", async () => {
    const tokens = countingTokens();
    api.answer(() => ({ status: 401, body: googleError(401, "authError") }));

    expect(await driver().insert(context(g, tokens.source), desired(g))).toEqual({
      ok: false,
      error: "auth_revoked",
      reason: "authError",
    });
    expect(tokens.calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    expect(api.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])(
    "maps a 403 %s to throttled",
    async (reason) => {
      api.answer(() => ({ status: 403, body: googleError(403, reason) }));

      expect(await driver().insert(context(g), desired(g))).toEqual({
        ok: false,
        error: "throttled",
        retryAfterSeconds: null,
      });
      expect(api.requests).toHaveLength(1);
    }
  );

  it("maps a 429 to throttled with Retry-After and does not retry on its own", async () => {
    api.answer(() => ({
      status: 429,
      body: googleError(429, "rateLimitExceeded"),
      headers: { "retry-after": "30" },
    }));

    expect(await driver().patch(context(g), "evt-1", desired(g))).toEqual({
      ok: false,
      error: "throttled",
      retryAfterSeconds: 30,
    });
    expect(api.requests).toHaveLength(1);
  });

  it("maps any other 403 to other with its reason", async () => {
    api.answer(() => ({ status: 403, body: googleError(403, "forbiddenForNonOrganizer") }));

    expect(await driver().patch(context(g), "evt-1", desired(g))).toEqual({
      ok: false,
      error: "other",
      reason: "forbiddenForNonOrganizer",
    });
  });

  it("maps a 5xx to other without retrying", async () => {
    api.answer(() => ({ status: 503, body: googleError(503, "backendError") }));

    expect(await driver().insert(context(g), desired(g))).toEqual({
      ok: false,
      error: "other",
      reason: "backendError",
    });
    expect(api.requests).toHaveLength(1);
  });

  it.each([404, 410])("counts a %i on delete as already gone", async (status) => {
    api.answer(() => ({ status, body: googleError(status, "deleted") }));

    expect(await driver().delete(context(g), "evt-1")).toEqual({ ok: true });
  });

  it.each([404, 410])("reports a %i on patch as not found", async (status) => {
    api.answer(() => ({ status, body: googleError(status, "notFound") }));

    expect(await driver().patch(context(g), "evt-1", desired(g))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("refuses an event built for another provider without calling out", async () => {
    expect(await driver().insert(context(g), desired(calendarProvider.Microsoft))).toEqual({
      ok: false,
      error: "other",
      reason: "provider_mismatch",
    });
    expect(api.requests).toHaveLength(0);
  });
});
