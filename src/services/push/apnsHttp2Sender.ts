import http2, { type ClientHttp2Session } from "node:http2";
import type { ApnsConfig } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import { pushEnvironment } from "../../db/schema/push-registration-schema.js";
import { parseEs256PrivateKey, signEs256Jwt } from "../../utils/es256Jwt.js";
import type { ApnsAnswer, ApnsPush, ApnsSender } from "./types.js";

export const APNS_ORIGINS: Record<pushEnvironment, string> = {
  [pushEnvironment.Sandbox]: "https://api.sandbox.push.apple.com",
  [pushEnvironment.Production]: "https://api.push.apple.com",
};

/** Apple wants a new provider token no sooner than 20 and no later than 60 minutes. */
const PROVIDER_TOKEN_SECONDS = 50 * 60;

/** Refusals of the cached token itself: the next send signs a fresh one instead of waiting it out. */
const PROVIDER_TOKEN_REFUSALS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

const reasonOf = (body: string): string | undefined => {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
};

export type ApnsConnectionTiming = { pingIntervalMs: number; pingTimeoutMs: number };

/**
 * A NAT or load balancer can drop an idle connection without a word, and every
 * push on it would then time out. An unanswered PING, or a send that timed
 * out, ends the connection so the next push opens a new one.
 */
const CONNECTION_TIMING: ApnsConnectionTiming = { pingIntervalMs: 60_000, pingTimeoutMs: 10_000 };

/**
 * One HTTP/2 connection per host for the life of the process, as Apple asks.
 * One team-scoped key signs for both hosts, so one provider token serves both.
 */
export function createApnsHttp2Sender(
  { keyId, teamId, topic, privateKey }: ApnsConfig,
  origins: Record<pushEnvironment, string> = APNS_ORIGINS,
  { pingIntervalMs, pingTimeoutMs }: ApnsConnectionTiming = CONNECTION_TIMING
): ApnsSender {
  const key = parseEs256PrivateKey(privateKey, "APNS_PRIVATE_KEY");
  let providerToken: { jwt: string; iat: number } | undefined;
  const sessions = new Map<string, ClientHttp2Session>();

  const bearer = (): string => {
    const now = Math.floor(Date.now() / 1000);
    if (!providerToken || now - providerToken.iat >= PROVIDER_TOKEN_SECONDS) {
      providerToken = { jwt: signEs256Jwt(key, keyId, { iss: teamId, iat: now }), iat: now };
    }
    return providerToken.jwt;
  };

  const forget = (origin: string, session: ClientHttp2Session) => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };

  const drop = (origin: string, session: ClientHttp2Session) => {
    forget(origin, session);
    if (!session.destroyed) session.destroy();
  };

  const sessionFor = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;

    const session = http2.connect(origin);
    session.unref();
    const heartbeat = setInterval(() => {
      if (session.destroyed) return;
      const deadline = setTimeout(() => {
        logger.warn("push.apns_connection_dead", { origin });
        drop(origin, session);
      }, pingTimeoutMs);
      deadline.unref();
      session.ping((error) => {
        clearTimeout(deadline);
        if (error) drop(origin, session);
      });
    }, pingIntervalMs);
    heartbeat.unref();
    session.on("goaway", () => forget(origin, session));
    session.on("close", () => {
      clearInterval(heartbeat);
      forget(origin, session);
    });
    session.on("error", (error: Error) => {
      logger.warn("push.apns_connection_error", { origin, error: error.message });
      drop(origin, session);
    });
    sessions.set(origin, session);
    return session;
  };

  return {
    send: ({ environment, token, payload, signal }: ApnsPush) =>
      new Promise<ApnsAnswer>((resolve, reject) => {
        const origin = origins[environment];
        const session = sessionFor(origin);
        const jwt = bearer();
        const request = session.request(
          {
            ":method": "POST",
            ":path": `/3/device/${token}`,
            authorization: `bearer ${jwt}`,
            "apns-topic": topic,
            "apns-push-type": "alert",
            "content-type": "application/json",
          },
          { signal }
        );
        let status = 0;
        let body = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => (status = Number(headers[":status"])));
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
          const reason = reasonOf(body);
          if (status === 403 && reason && PROVIDER_TOKEN_REFUSALS.has(reason)) {
            if (providerToken?.jwt === jwt) providerToken = undefined;
          }
          resolve(reason ? { status, reason } : { status });
        });
        request.on("error", (error) => {
          if (signal?.aborted) drop(origin, session);
          reject(error);
        });
        request.end(JSON.stringify(payload));
      }),
  };
}
