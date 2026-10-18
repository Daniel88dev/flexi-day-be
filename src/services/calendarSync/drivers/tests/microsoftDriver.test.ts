import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { calendarProvider } from "../../../../db/schema/calendar-connection-schema.js";
import {
  ProviderGrantRevokedError,
  ProviderTokenError,
} from "../../../calendarConnection/providers/types.js";
import { createMicrosoftDriver } from "../microsoftDriver.js";
import { context, countingTokens, desired } from "./context.js";
import { startFakeApi, type FakeApi } from "./fakeApi.js";

let graph: FakeApi;

beforeAll(async () => {
  graph = await startFakeApi();
});

afterAll(async () => {
  await graph.close();
});

beforeEach(() => {
  graph.requests.length = 0;
});

const driver = () => createMicrosoftDriver({ baseUrl: graph.url });
const ms = calendarProvider.Microsoft;
const graphError = (code: string) => ({ error: { code, message: "secret token abc" } });

describe("Microsoft driver, writes", () => {
  it("posts the event to the default calendar and returns its id", async () => {
    graph.answer(() => ({ status: 201, body: { id: "AAMk-1" } }));
    const event = desired(ms);

    const result = await driver().insert(context(ms), event);

    expect(result).toEqual({ ok: true, providerEventId: "AAMk-1" });
    const [request] = graph.requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/me/events");
    expect(request?.headers.authorization).toBe("Bearer token-1");
    expect(request?.headers.prefer).toBe('IdType="ImmutableId"');
    expect(request?.body).toEqual(event.payload);
  });

  it("patches without the transaction id, which Graph keeps immutable", async () => {
    graph.answer(() => ({ status: 200, body: { id: "AAMk-1" } }));

    const result = await driver().patch(context(ms), "AAMk/1", desired(ms));

    expect(result).toEqual({ ok: true, providerEventId: "AAMk-1" });
    expect(graph.requests[0]?.method).toBe("PATCH");
    expect(graph.requests[0]?.path).toBe("/me/events/AAMk%2F1");
    expect(graph.requests[0]?.body).not.toHaveProperty("transactionId");
    expect(graph.requests[0]?.body).toMatchObject({ subject: "Vacation", showAs: "oof" });
  });

  it("patches a series without its start, end or rule, which keeps its cancelled occurrences", async () => {
    graph.answer(() => ({ status: 200, body: { id: "AAMk-1" } }));
    const event = desired(ms);
    if (event.provider !== ms) throw new Error("unreachable");
    const series = {
      ...event,
      payload: {
        ...event.payload,
        recurrence: {
          pattern: { type: "daily" as const, interval: 1 },
          range: { type: "noEnd" as const, startDate: "2026-12-21" },
        },
      },
      cancelledDates: ["2026-12-22"],
    };

    await driver().patch(context(ms), "AAMk-1", series);

    const body = graph.requests[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["body", "isReminderOn", "showAs", "subject"]);
  });

  it("deletes the event", async () => {
    graph.answer(() => ({ status: 204 }));

    expect(await driver().delete(context(ms), "AAMk-1")).toEqual({ ok: true });
    expect(graph.requests[0]?.method).toBe("DELETE");
    expect(graph.requests[0]?.path).toBe("/me/events/AAMk-1");
  });
});

describe("Microsoft driver, failures", () => {
  it("counts a 404 on delete as already gone", async () => {
    graph.answer(() => ({ status: 404, body: graphError("ErrorItemNotFound") }));

    expect(await driver().delete(context(ms), "gone")).toEqual({ ok: true });
  });

  it("reports a 404 on patch as not found", async () => {
    graph.answer(() => ({ status: 404, body: graphError("ErrorItemNotFound") }));

    expect(await driver().patch(context(ms), "gone", desired(ms))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("refreshes once on 401 and succeeds with the new token", async () => {
    const tokens = countingTokens();
    graph.answer((request) =>
      request.headers.authorization === "Bearer token-2"
        ? { status: 201, body: { id: "AAMk-1" } }
        : { status: 401, body: graphError("InvalidAuthenticationToken") }
    );

    const result = await driver().insert(context(ms, tokens.source), desired(ms));

    expect(result).toEqual({ ok: true, providerEventId: "AAMk-1" });
    expect(tokens.calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
  });

  it("maps a 401 InvalidAuthenticationToken after one refresh to auth_revoked", async () => {
    graph.answer(() => ({ status: 401, body: graphError("InvalidAuthenticationToken") }));

    expect(await driver().insert(context(ms), desired(ms))).toEqual({
      ok: false,
      error: "auth_revoked",
      reason: "InvalidAuthenticationToken",
    });
    expect(graph.requests).toHaveLength(2);
  });

  it("maps a revoked grant at the token endpoint to auth_revoked without calling Graph", async () => {
    const revoked = () => Promise.reject(new ProviderGrantRevokedError("invalid_grant"));

    expect(await driver().delete(context(ms, revoked), "AAMk-1")).toEqual({
      ok: false,
      error: "auth_revoked",
      reason: "invalid_grant",
    });
    expect(graph.requests).toHaveLength(0);
  });

  it.each([429, 503])("maps %i to throttled with Retry-After", async (status) => {
    graph.answer(() => ({
      status,
      body: graphError("TooManyRequests"),
      headers: { "retry-after": "17" },
    }));

    expect(await driver().insert(context(ms), desired(ms))).toEqual({
      ok: false,
      error: "throttled",
      retryAfterSeconds: 17,
    });
  });

  it("maps a 429 without Retry-After to throttled with no delay named", async () => {
    graph.answer(() => ({ status: 429, body: graphError("TooManyRequests") }));

    expect(await driver().delete(context(ms), "AAMk-1")).toEqual({
      ok: false,
      error: "throttled",
      retryAfterSeconds: null,
    });
  });

  it("maps any other error to other with the Graph code, never its message", async () => {
    graph.answer(() => ({ status: 400, body: graphError("ErrorInvalidRequest") }));

    const result = await driver().insert(context(ms), desired(ms));

    expect(result).toEqual({ ok: false, error: "other", reason: "ErrorInvalidRequest" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("falls back to the HTTP status when the error code is not a plain code", async () => {
    graph.answer(() => ({ status: 500, body: { error: { code: "Bearer eyJ0eXAi leaked" } } }));

    expect(await driver().insert(context(ms), desired(ms))).toEqual({
      ok: false,
      error: "other",
      reason: "http_500",
    });
  });

  it("maps a token endpoint failure to other with its reason", async () => {
    const broken = () => Promise.reject(new ProviderTokenError("http_503"));

    expect(await driver().insert(context(ms, broken), desired(ms))).toEqual({
      ok: false,
      error: "other",
      reason: "http_503",
    });
  });

  it("maps a network failure to other with the error name", async () => {
    const closed = createMicrosoftDriver({ baseUrl: "http://127.0.0.1:1" });

    expect(await closed.insert(context(ms), desired(ms))).toEqual({
      ok: false,
      error: "other",
      reason: "TypeError",
    });
  });
});

describe("Microsoft driver, cancelling one occurrence", () => {
  const instance = (id: string, utc: string) => ({
    id,
    start: { dateTime: `${utc}.0000000`, timeZone: "UTC" },
  });

  it("reads the instances around that day and deletes the one on it in the event's zone", async () => {
    graph.answer((request) =>
      request.method === "GET"
        ? {
            status: 200,
            body: {
              value: [
                instance("occ-21", "2026-12-21T08:00:00"),
                instance("occ-22", "2026-12-22T08:00:00"),
                instance("occ-23", "2026-12-23T08:00:00"),
              ],
            },
          }
        : { status: 204 }
    );

    const result = await driver().cancelOccurrence!(
      context(ms),
      "AAMk/series",
      "2026-12-22",
      "Europe/Prague"
    );

    expect(result).toEqual({ ok: true });
    const [read, remove] = graph.requests;
    expect(read?.method).toBe("GET");
    const url = new URL(read!.path, "http://graph.test");
    expect(url.pathname).toBe("/me/events/AAMk%2Fseries/instances");
    expect(url.searchParams.get("startDateTime")).toBe("2026-12-21T00:00:00Z");
    expect(url.searchParams.get("endDateTime")).toBe("2026-12-24T00:00:00Z");
    expect(read?.headers.prefer).toBe('IdType="ImmutableId", outlook.timezone="Europe/Prague"');
    expect(remove?.method).toBe("DELETE");
    expect(remove?.path).toBe("/me/events/occ-22");
    expect(graph.requests).toHaveLength(2);
  });

  it("converts a timed occurrence Graph still answered in UTC to the zone", async () => {
    graph.answer((request) =>
      request.method === "GET"
        ? { status: 200, body: { value: [instance("occ-22", "2026-12-21T23:00:00")] } }
        : { status: 204 }
    );

    await driver().cancelOccurrence!(context(ms), "series", "2026-12-22", "Europe/Prague");

    expect(graph.requests[1]?.path).toBe("/me/events/occ-22");
  });

  it("matches an all-day occurrence by its date west of UTC", async () => {
    const allDay = (id: string, date: string) => ({
      id,
      isAllDay: true,
      start: { dateTime: `${date}T00:00:00.0000000`, timeZone: "UTC" },
    });
    graph.answer((request) =>
      request.method === "GET"
        ? {
            status: 200,
            body: {
              value: [
                allDay("occ-21", "2026-12-21"),
                allDay("occ-22", "2026-12-22"),
                allDay("occ-23", "2026-12-23"),
              ],
            },
          }
        : { status: 204 }
    );

    await driver().cancelOccurrence!(context(ms), "series", "2026-12-22", "America/New_York");

    expect(graph.requests[0]?.headers.prefer).toBe(
      'IdType="ImmutableId", outlook.timezone="America/New_York"'
    );
    expect(graph.requests[1]?.path).toBe("/me/events/occ-22");
  });

  it("matches a timed occurrence by its local date west of UTC", async () => {
    const local = (id: string, dateTime: string) => ({
      id,
      isAllDay: false,
      start: { dateTime: `${dateTime}.0000000`, timeZone: "America/New_York" },
    });
    graph.answer((request) =>
      request.method === "GET"
        ? {
            status: 200,
            body: {
              value: [
                local("occ-21", "2026-12-21T02:00:00"),
                local("occ-22", "2026-12-22T02:00:00"),
                local("occ-23", "2026-12-23T02:00:00"),
              ],
            },
          }
        : { status: 204 }
    );

    await driver().cancelOccurrence!(context(ms), "series", "2026-12-22", "America/New_York");

    expect(graph.requests[1]?.path).toBe("/me/events/occ-22");
    expect(graph.requests).toHaveLength(2);
  });

  it("does nothing more when no occurrence falls on that day", async () => {
    graph.answer(() => ({
      status: 200,
      body: { value: [instance("occ-21", "2026-12-21T08:00:00")] },
    }));

    expect(
      await driver().cancelOccurrence!(context(ms), "series", "2026-12-22", "Europe/Prague")
    ).toEqual({ ok: true });
    expect(graph.requests).toHaveLength(1);
  });

  it("maps a failed instances read like any other call", async () => {
    graph.answer(() => ({ status: 429, body: graphError("TooManyRequests") }));

    expect(
      await driver().cancelOccurrence!(context(ms), "series", "2026-12-22", "Europe/Prague")
    ).toEqual({ ok: false, error: "throttled", retryAfterSeconds: null });
  });
});
