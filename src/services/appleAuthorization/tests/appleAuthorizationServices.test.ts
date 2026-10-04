import { beforeEach, describe, expect, it, vi } from "vitest";
import { appleCredentials } from "../../../tests/appleFixtures.js";
import { decryptStoredOAuthToken } from "../../../utils/oauthTokens.js";
import { appleClientFrom } from "../../../utils/socialProviders.js";
import type { AppleExchange, StoredAppleTokens } from "../types.js";

const { mockFindAppleAccounts, mockSaveAppleTokens, mockExchange, appleSettings } = vi.hoisted(
  () => ({
    mockFindAppleAccounts: vi.fn(),
    mockSaveAppleTokens: vi.fn(),
    mockExchange: vi.fn(),
    appleSettings: { current: undefined as unknown },
  })
);

vi.mock("../appleAccounts.js", () => ({
  findAppleAccounts: mockFindAppleAccounts,
  saveAppleTokens: mockSaveAppleTokens,
}));

vi.mock("../appleTokenExchange.js", () => ({ exchangeAppleAuthorizationCode: mockExchange }));

vi.mock("../../../utils/auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../utils/auth.js")>();
  return {
    ...original,
    get appleClient() {
      return appleSettings.current;
    },
  };
});

import { storeAppleAuthorization } from "../appleAuthorizationServices.js";

const SUBJECT = "001234.abcdef0123456789.1234";
const appleLink = { id: "account-row-1", accountId: SUBJECT };
const exchanged: AppleExchange = {
  accessToken: "apple-access-token",
  refreshToken: "apple-refresh-token",
  accessTokenExpiresAt: new Date("2026-10-04T13:00:00Z"),
  idToken: "header.payload.signature",
  subject: SUBJECT,
};

beforeEach(() => {
  vi.clearAllMocks();
  appleSettings.current = appleClientFrom(appleCredentials());
  mockFindAppleAccounts.mockResolvedValue([appleLink]);
  mockExchange.mockResolvedValue(exchanged);
});

describe("storeAppleAuthorization", () => {
  it("refuses without an Apple link, before asking Apple", async () => {
    mockFindAppleAccounts.mockResolvedValue([]);

    expect(await storeAppleAuthorization("user-1", "c0de")).toEqual({
      stored: false,
      refusal: "APPLE_ACCOUNT_MISSING",
    });
    expect(mockFindAppleAccounts).toHaveBeenCalledWith("user-1");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("refuses and stores nothing when the exchange fails", async () => {
    mockExchange.mockResolvedValue(null);

    expect(await storeAppleAuthorization("user-1", "c0de")).toEqual({
      stored: false,
      refusal: "APPLE_EXCHANGE_FAILED",
    });
    expect(mockExchange).toHaveBeenCalledTimes(1);
    expect(mockExchange).toHaveBeenCalledWith(appleSettings.current, "c0de");
    expect(mockSaveAppleTokens).not.toHaveBeenCalled();
  });

  it("refuses when Apple is not configured on this server", async () => {
    appleSettings.current = undefined;

    expect(await storeAppleAuthorization("user-1", "c0de")).toEqual({
      stored: false,
      refusal: "APPLE_EXCHANGE_FAILED",
    });
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("refuses and stores nothing when the code belongs to another Apple ID", async () => {
    mockExchange.mockResolvedValue({ ...exchanged, subject: "009999.someone-else.0001" });

    expect(await storeAppleAuthorization("user-1", "c0de")).toEqual({
      stored: false,
      refusal: "APPLE_SUBJECT_MISMATCH",
    });
    expect(mockSaveAppleTokens).not.toHaveBeenCalled();
  });

  it("stores the tokens on the link, encrypted the way better-auth writes them", async () => {
    expect(await storeAppleAuthorization("user-1", "c0de")).toEqual({ stored: true });

    expect(mockSaveAppleTokens).toHaveBeenCalledTimes(1);
    const [rowId, stored] = mockSaveAppleTokens.mock.calls[0] as [string, StoredAppleTokens];
    expect(rowId).toBe("account-row-1");
    expect(stored.refreshToken).not.toBe("apple-refresh-token");
    expect(await decryptStoredOAuthToken(stored.refreshToken)).toBe("apple-refresh-token");
    expect(stored.accessToken).not.toBe("apple-access-token");
    expect(await decryptStoredOAuthToken(stored.accessToken)).toBe("apple-access-token");
    expect(stored.accessTokenExpiresAt).toEqual(exchanged.accessTokenExpiresAt);
    expect(stored.idToken).toBe(exchanged.idToken);
  });

  it("picks the link whose subject Apple returned when the user holds two", async () => {
    mockFindAppleAccounts.mockResolvedValue([
      { id: "account-row-0", accountId: "000001.other.0001" },
      appleLink,
    ]);

    await storeAppleAuthorization("user-1", "c0de");

    expect(mockSaveAppleTokens).toHaveBeenCalledWith("account-row-1", expect.anything());
  });
});
