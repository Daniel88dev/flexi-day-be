import http2, { type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { verify, type KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pushEnvironment } from "../../../db/schema/push-registration-schema.js";
import { createApnsHttp2Sender } from "../apnsHttp2Sender.js";
import type { ApnsPayload } from "../types.js";
import { decodeJwtPart, newP256Key } from "../../../tests/appleFixtures.js";

type Received = { host: string; headers: IncomingHttpHeaders; body: string };

const verifiesAsEs256 = (jwt: string, publicKey: KeyObject) => {
  const [header, payload, signature] = jwt.split(".");
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature ?? "", "base64url")
  );
};

/** A cleartext HTTP/2 server standing in for one APNs host. */
const fakeApnsHost = async (name: string, received: Received[]) => {
  let answer: { status: number; reason?: string } = { status: 200 };
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer();
  server.on("session", (session) => sessions.add(session));
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (body += chunk));
    stream.on("end", () => {
      received.push({ host: name, headers, body });
      stream.respond({ ":status": answer.status });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`,
    answerWith: (next: { status: number; reason?: string }) => (answer = next),
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => resolve());
      }),
  };
};

const PAYLOAD: ApnsPayload = {
  aps: { alert: { title: "Request approved", body: "Your leave was approved" }, badge: 2 },
  notificationId: "0b9f1d8e-7c2a-4d6b-9f3e-1a2b3c4d5e6f",
  href: "/requests/",
};
const TOKEN = "ab".repeat(32);

describe("createApnsHttp2Sender", () => {
  const key = newP256Key();
  const received: Received[] = [];
  let sandbox: Awaited<ReturnType<typeof fakeApnsHost>>;
  let production: Awaited<ReturnType<typeof fakeApnsHost>>;

  beforeAll(async () => {
    sandbox = await fakeApnsHost("sandbox", received);
    production = await fakeApnsHost("production", received);
  });

  afterAll(async () => {
    await sandbox.close();
    await production.close();
  });

  afterEach(() => {
    received.length = 0;
    sandbox.answerWith({ status: 200 });
    production.answerWith({ status: 200 });
    vi.useRealTimers();
  });

  const senderFor = () =>
    createApnsHttp2Sender(
      { keyId: "KEY1234567", teamId: "TEAM123456", topic: "com.flexiday.app", privateKey: key.pem },
      { sandbox: sandbox.origin, production: production.origin }
    );

  const bearerOf = (headers: IncomingHttpHeaders) =>
    String(headers.authorization).replace(/^bearer /, "");

  it("posts the payload to the device path on the registration's host", async () => {
    const answer = await senderFor().send({
      environment: pushEnvironment.Production,
      token: TOKEN,
      payload: PAYLOAD,
    });

    expect(answer).toEqual({ status: 200 });
    expect(received).toHaveLength(1);
    const [push] = received;
    expect(push?.host).toBe("production");
    expect(push?.headers[":method"]).toBe("POST");
    expect(push?.headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(push?.headers["apns-topic"]).toBe("com.flexiday.app");
    expect(push?.headers["apns-push-type"]).toBe("alert");
    expect(JSON.parse(push?.body ?? "")).toEqual(PAYLOAD);
  });

  it("sends sandbox registrations to the sandbox host", async () => {
    await senderFor().send({
      environment: pushEnvironment.Sandbox,
      token: TOKEN,
      payload: PAYLOAD,
    });

    expect(received.map((push) => push.host)).toEqual(["sandbox"]);
  });

  it("signs an ES256 provider token with the key id and team id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));

    await senderFor().send({
      environment: pushEnvironment.Sandbox,
      token: TOKEN,
      payload: PAYLOAD,
    });

    const jwt = bearerOf(received[0]!.headers);
    expect(decodeJwtPart(jwt, 0)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(decodeJwtPart(jwt, 1)).toEqual({
      iss: "TEAM123456",
      iat: new Date("2026-10-17T12:00:00Z").getTime() / 1000,
    });
    expect(verifiesAsEs256(jwt, key.publicKey)).toBe(true);
  });

  it("reuses the provider token for 50 minutes and signs a new one after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const sender = senderFor();
    const push = { environment: pushEnvironment.Sandbox, token: TOKEN, payload: PAYLOAD };

    await sender.send(push);
    vi.setSystemTime(new Date("2026-10-17T12:49:59Z"));
    await sender.send(push);
    vi.setSystemTime(new Date("2026-10-17T12:50:00Z"));
    await sender.send(push);

    const [first, second, third] = received.map((r) => bearerOf(r.headers));
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(decodeJwtPart(third, 1).iat).toBe(new Date("2026-10-17T12:50:00Z").getTime() / 1000);
  });

  it("keeps one connection per host across sends", async () => {
    const sender = senderFor();
    const push = { environment: pushEnvironment.Production, token: TOKEN, payload: PAYLOAD };
    const before = production.sessions.size;

    await Promise.all([sender.send(push), sender.send(push), sender.send(push)]);

    expect(production.sessions.size - before).toBe(1);
  });

  it("returns the status and Apple's reason when APNs refuses", async () => {
    production.answerWith({ status: 410, reason: "Unregistered" });

    const answer = await senderFor().send({
      environment: pushEnvironment.Production,
      token: TOKEN,
      payload: PAYLOAD,
    });

    expect(answer).toEqual({ status: 410, reason: "Unregistered" });
  });

  it("refuses a key that is not EC P-256", () => {
    expect(() =>
      createApnsHttp2Sender({
        keyId: "KEY1234567",
        teamId: "TEAM123456",
        topic: "com.flexiday.app",
        privateKey: "not a key",
      })
    ).toThrow("APNS_PRIVATE_KEY is not a PEM private key");
  });
});
