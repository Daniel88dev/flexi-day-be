import { describe, it, expect, vi, beforeEach } from "vitest";

const { configRows, connectionRows, writes, exchangeCode } = vi.hoisted(() => ({
  configRows: { value: [] as unknown[] },
  connectionRows: { value: [] as unknown[] },
  writes: { count: 0 },
  exchangeCode: vi.fn(),
}));

vi.mock("../../../db/db.js", () => {
  const write = () => {
    writes.count += 1;
    throw new Error("no write expected");
  };
  return {
    db: {
      select: (columns?: object) => ({
        from: () => ({
          where: async () => (columns ? connectionRows.value : configRows.value),
        }),
      }),
      insert: write,
      update: write,
      delete: write,
      transaction: write,
    },
  };
});

vi.mock("../../../utils/oauthTokens.js", () => ({
  authSecret: async () => "test-secret",
  encryptOAuthToken: async (token: string) => token,
  decryptStoredOAuthToken: async (token: string) => token,
}));

vi.mock("../providers/index.js", () => ({
  providerAdapter: () => ({
    grantsCalendarScope: () => true,
    exchangeCode,
  }),
}));

import { completeConnection } from "../calendarConnectionServices.js";
import { OAUTH_STATE_TTL_MS, signOAuthState } from "../oauthState.js";
import { tamper } from "./tamperState.js";
import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import { calendarSyncScope } from "../../../db/schema/calendar-sync-schema.js";

const STATE_INPUT = {
  userId: "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
  configId: "6c1f8a52-9d3e-4b7a-8f21-3e5d7c9a1b40",
  timeZone: "Europe/Prague",
  provider: calendarProvider.Google,
};

const callback = (state: string, code = "the-code") =>
  completeConnection(calendarProvider.Google, { state, code });

describe("completeConnection", () => {
  beforeEach(() => {
    configRows.value = [];
    connectionRows.value = [];
    writes.count = 0;
    exchangeCode.mockReset();
  });

  it.each([
    [
      "expired",
      () => signOAuthState(STATE_INPUT, "test-secret", Date.now() - OAUTH_STATE_TTL_MS - 1),
    ],
    ["tampered", () => tamper(signOAuthState(STATE_INPUT, "test-secret"))],
    ["signed with another key", () => signOAuthState(STATE_INPUT, "another-secret")],
    [
      "minted for the other provider",
      () => signOAuthState({ ...STATE_INPUT, provider: calendarProvider.Microsoft }, "test-secret"),
    ],
  ])("rejects a state that is %s and writes nothing", async (_case, state) => {
    expect(await callback(state())).toEqual({ ok: false, error: "state_invalid" });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
  });

  it("rejects a genuine state naming a config its user does not own, and writes nothing", async () => {
    configRows.value = [];

    const outcome = await callback(signOAuthState(STATE_INPUT, "test-secret"));

    expect(outcome).toEqual({ ok: false, error: "config_not_found" });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
  });

  it("refuses a config that turned TEAM since the consent began", async () => {
    configRows.value = [{ id: STATE_INPUT.configId, scope: calendarSyncScope.Team }];

    const outcome = await callback(signOAuthState(STATE_INPUT, "test-secret"));

    expect(outcome).toEqual({ ok: false, error: "team_scope", configId: STATE_INPUT.configId });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
  });

  it("reports a declined consent without exchanging anything", async () => {
    const outcome = await completeConnection(calendarProvider.Google, {
      state: signOAuthState(STATE_INPUT, "test-secret"),
      error: "access_denied",
    });

    expect(outcome).toEqual({
      ok: false,
      error: "consent_denied",
      configId: STATE_INPUT.configId,
    });
    expect(writes.count).toBe(0);
  });

  it("reports a failed exchange without writing", async () => {
    configRows.value = [{ id: STATE_INPUT.configId, scope: calendarSyncScope.Me }];
    exchangeCode.mockRejectedValue(new Error("invalid_grant"));

    const outcome = await callback(signOAuthState(STATE_INPUT, "test-secret"));

    expect(outcome).toEqual({
      ok: false,
      error: "exchange_failed",
      configId: STATE_INPUT.configId,
    });
    expect(writes.count).toBe(0);
  });

  it("refuses a config that already syncs through the other provider", async () => {
    configRows.value = [
      { id: STATE_INPUT.configId, scope: calendarSyncScope.Me, connectionId: "connection-ms" },
    ];
    connectionRows.value = [{ provider: calendarProvider.Microsoft }];

    const outcome = await callback(signOAuthState(STATE_INPUT, "test-secret"));

    expect(outcome).toEqual({
      ok: false,
      error: "target_exists",
      configId: STATE_INPUT.configId,
    });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
  });
});
