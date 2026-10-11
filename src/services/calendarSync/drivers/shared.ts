import {
  ProviderGrantRevokedError,
  ProviderTokenError,
} from "../../calendarConnection/providers/types.js";
import type { DriverContext, DriverFailure, DriverResult } from "./types.js";

export const REQUEST_TIMEOUT_MS = 10_000;

const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A provider error code fit to store and log; anything else becomes the fallback. */
export const safeReason = (value: unknown, fallback: string): string =>
  typeof value === "string" && SAFE_REASON.test(value) ? value : fallback;

export const otherFailure = (reason: string): DriverFailure => ({
  ok: false,
  error: "other",
  reason,
});

/** `Retry-After` as seconds: either delta-seconds or an HTTP date. */
export const retryAfterSeconds = (
  header: string | null | undefined,
  now = Date.now()
): number | null => {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
};

export type Unauthorized = { unauthorized: true; reason: string };

/**
 * Runs one provider request with the connection's token. A 401 earns one
 * forced refresh and a second try; a second 401 means the grant is gone.
 */
export const withAccessToken = async <T extends object>(
  context: DriverContext,
  call: (token: string) => Promise<DriverResult<T> | Unauthorized>
): Promise<DriverResult<T>> => {
  try {
    let answer = await call(await context.accessToken());
    if ("unauthorized" in answer) {
      answer = await call(await context.accessToken({ forceRefresh: true }));
    }
    if ("unauthorized" in answer) {
      return { ok: false, error: "auth_revoked", reason: answer.reason };
    }
    return answer;
  } catch (error) {
    if (error instanceof ProviderGrantRevokedError) {
      return { ok: false, error: "auth_revoked", reason: safeReason(error.reason, "revoked") };
    }
    if (error instanceof ProviderTokenError) {
      return otherFailure(safeReason(error.reason, "token_error"));
    }
    return otherFailure(safeReason(error instanceof Error ? error.name : undefined, "unknown"));
  }
};
