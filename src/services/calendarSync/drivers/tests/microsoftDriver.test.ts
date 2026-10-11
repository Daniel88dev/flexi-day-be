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
