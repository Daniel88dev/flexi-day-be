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

const reasonOf = (body: string): string | undefined => {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One HTTP/2 connection per host for the life of the process, as Apple asks.
 * One team-scoped key signs for both hosts, so one provider token serves both.
 */
export function createApnsHttp2Sender(
  { keyId, teamId, topic, privateKey }: ApnsConfig,
  origins: Record<pushEnvironment, string> = APNS_ORIGINS
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

  const sessionFor = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;

    const session = http2.connect(origin);
    session.unref();
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on("goaway", forget);
    session.on("close", forget);
    session.on("error", (error: Error) => {
      forget();
      logger.warn("push.apns_connection_error", { origin, error: error.message });
    });
    sessions.set(origin, session);
    return session;
  };

  return {
    send: ({ environment, token, payload, signal }: ApnsPush) =>
      new Promise<ApnsAnswer>((resolve, reject) => {
        const request = sessionFor(
          environment === pushEnvironment.Sandbox ? origins.sandbox : origins.production
        ).request(
          {
            ":method": "POST",
            ":path": `/3/device/${token}`,
            authorization: `bearer ${bearer()}`,
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
          resolve(reason ? { status, reason } : { status });
        });
        request.on("error", reject);
        request.end(JSON.stringify(payload));
      }),
  };
}
