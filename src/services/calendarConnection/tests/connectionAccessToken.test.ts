import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  startFakeTokenEndpoint,
  type FakeTokenEndpoint,
} from "../providers/tests/fakeTokenEndpoint.js";
import type { CalendarProviderAdapter } from "../providers/types.js";

const { writes, adapterRef } = vi.hoisted(() => ({
  writes: [] as { table: string; values: Record<string, unknown> }[],
  adapterRef: { value: undefined as CalendarProviderAdapter | undefined },
}));

vi.mock("../../../db/db.js", () => {
  const executor = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          writes.push({ table: getTableName(table as never), values });
        },
      }),
    }),
  };
  return {
    db: { ...executor, transaction: async (fn: (tx: unknown) => unknown) => fn(executor) },
  };
});

vi.mock("../../../utils/oauthTokens.js", () => ({
  encryptOAuthToken: async (token: string) => `enc(${token})`,
  decryptStoredOAuthToken: async (stored: string) => stored.replace(/^enc\((.*)\)$/, "$1"),
}));

vi.mock("../providers/index.js", () => ({
  providerAdapter: () => adapterRef.value,
}));

import {
  connectionAccessToken,
  connectionTokenSource,
  startConnection,
} from "../calendarConnectionServices.js";
import { CALENDAR_SYNC_PROVIDER_OFF } from "../types.js";
import { createMicrosoftAdapter } from "../providers/microsoft.js";
import { ProviderGrantRevokedError } from "../providers/types.js";
import {
  calendarCapability,
  calendarConnectionStatus,
  calendarProvider,
} from "../../../db/schema/calendar-connection-schema.js";
import type { CalendarConnectionRecord } from "../types.js";

const connection = (
  overrides: Partial<CalendarConnectionRecord> = {}
): CalendarConnectionRecord => ({
  id: "connection-1",
  userId: "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
  provider: calendarProvider.Microsoft,
  refreshTokenEnc: "enc(refresh-1)",
  accessTokenEnc: "enc(access-1)",
  accessTokenExpiresAt: new Date(Date.now() - 1000),
  grantedScopes: "Calendars.ReadWrite",
  capability: calendarCapability.Unknown,
  status: calendarConnectionStatus.Active,
  lastErrorAt: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

let endpoint: FakeTokenEndpoint;

beforeAll(async () => {
  endpoint = await startFakeTokenEndpoint();
});

afterAll(async () => {
  await endpoint.close();
});

beforeEach(() => {
  writes.length = 0;
  endpoint.requests.length = 0;
  adapterRef.value = createMicrosoftAdapter({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:8080/callback",
    authority: `${endpoint.url}/common/oauth2/v2.0`,
  });
});

describe("connectionAccessToken", () => {
  it("persists the refresh token Microsoft rotated", async () => {
    endpoint.answer(() => ({
      status: 200,
      body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 },
    }));

    const token = await connectionAccessToken(connection());

    expect(token).toBe("access-2");
    expect(endpoint.requests[0]!.form.get("refresh_token")).toBe("refresh-1");
    expect(writes).toEqual([
      {
        table: "calendar_connection",
        values: {
          accessTokenEnc: "enc(access-2)",
          accessTokenExpiresAt: expect.any(Date),
          refreshTokenEnc: "enc(refresh-2)",
        },
      },
    ]);
  });

  it("writes nothing while the stored token is still good", async () => {
    const token = await connectionAccessToken(
      connection({ accessTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000) })
    );

    expect(token).toBe("access-1");
    expect(endpoint.requests).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  it("flips the connection to needs-reconnect on invalid_grant and stops its targets", async () => {
    endpoint.answer(() => ({ status: 400, body: { error: "invalid_grant" } }));

    await expect(connectionAccessToken(connection())).rejects.toBeInstanceOf(
      ProviderGrantRevokedError
    );

    expect(writes).toEqual([
      {
        table: "calendar_connection",
        values: { status: calendarConnectionStatus.NeedsReconnect, lastErrorAt: expect.any(Date) },
      },
      {
        table: "calendar_sync",
        values: { syncDueAt: null, syncAttempts: 0, lastError: "auth_revoked" },
      },
    ]);
  });

  it("does not call out for a connection already waiting on a reconnect", async () => {
    await expect(
      connectionAccessToken(connection({ status: calendarConnectionStatus.NeedsReconnect }))
    ).rejects.toBeInstanceOf(ProviderGrantRevokedError);

    expect(endpoint.requests).toHaveLength(0);
  });

  it("leaves the connection alone on a transient failure", async () => {
    endpoint.answer(() => ({ status: 503, body: { error: "temporarily_unavailable" } }));

    await expect(connectionAccessToken(connection())).rejects.toThrow();

    expect(writes).toEqual([]);
  });
});

describe("connectionAccessToken after the provider refused the token", () => {
  const stillGood = () =>
    connection({ accessTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000) });

  it("refreshes on forceRefresh although the stored token has not expired", async () => {
    endpoint.answer(() => ({
      status: 200,
      body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 },
    }));

    expect(await connectionAccessToken(stillGood(), { forceRefresh: true })).toBe("access-2");
    expect(endpoint.requests).toHaveLength(1);
  });

  it("hands one token to every call of a run until a refresh is forced", async () => {
    endpoint.answer(() => ({
      status: 200,
      body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 },
    }));
    const source = connectionTokenSource(stillGood());

    expect([await source(), await source()]).toEqual(["access-1", "access-1"]);
    expect(await source({ forceRefresh: true })).toBe("access-2");
    expect(await source()).toBe("access-2");
    expect(endpoint.requests).toHaveLength(1);
  });

  it("asks again after a failed attempt instead of repeating the failure", async () => {
    endpoint.answer(() => ({ status: 503, body: { error: "temporarily_unavailable" } }));
    const source = connectionTokenSource(connection());

    await expect(source()).rejects.toThrow();
    endpoint.answer(() => ({
      status: 200,
      body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 },
    }));

    expect(await source()).toBe("access-2");
  });
});

describe("a provider whose switch is off", () => {
  it("refuses start and token use with CALENDAR_SYNC_PROVIDER_OFF", async () => {
    adapterRef.value = undefined;
    const offError = expect.objectContaining({
      statusCode: 404,
      errors: [expect.objectContaining({ publicContext: { code: CALENDAR_SYNC_PROVIDER_OFF } })],
    });

    await expect(
      startConnection({
        userId: "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
        provider: calendarProvider.Microsoft,
        configId: "6c1f8a52-9d3e-4b7a-8f21-3e5d7c9a1b40",
        timeZone: "Europe/Prague",
      })
    ).rejects.toEqual(offError);
    await expect(connectionAccessToken(connection())).rejects.toEqual(offError);
  });
});
