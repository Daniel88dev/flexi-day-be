import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createServer } from "../../server.js";
import { authCookieFor, createWebUser, webSessionCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addQuota,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
  seedMembers,
} from "./helpers/reportFixtures.js";

const THIS_YEAR = new Date().getUTCFullYear();

/**
 * `compression`'s own default threshold is 1 KB, so a control route has to
 * answer more than that before its missing `Content-Encoding` proves anything:
 * below it, a `compression()` mounted globally would look identical.
 */
const COMPRESSION_DEFAULT_THRESHOLD = 1024;

const rateLimitHeaderNames = (res: request.Response): string[] =>
  Object.keys(res.headers)
    .filter((name) => name.startsWith("ratelimit"))
    .sort();

/**
 * The transport around the sync pull: gzip mounted on this router and nowhere
 * else, `Cache-Control: no-store` surviving it, and both kinds of session the
 * endpoint is meant to answer — the cookie better-auth sets at sign-in and the
 * signed cookie `utils/devSession.ts` mints.
 */
describe("Sync pull transport E2E", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await resetReportData();
  });

  /** Enough rows that the envelope is a real payload rather than eight empty arrays. */
  const seedGroupFor = async (userId: string): Promise<string> => {
    const groupId = await makeGroup("Engineering", userId);
    await addMember(groupId, userId, { viewAccess: true });
    await seedMembers(groupId, 5);
    await addQuota(groupId, userId, THIS_YEAR);
    await addLeave(groupId, userId, dayIn(THIS_YEAR, 3, 4), { note: "Long weekend" });
    await addLeave(groupId, userId, dayIn(THIS_YEAR, 3, 5), { note: "Long weekend" });
    return groupId;
  };

  describe("GET /api/sync/pull", () => {
    it("gzip-encodes the pull when the client accepts gzip", async () => {
      const caller = await makeUser("Caller");
      await seedGroupFor(caller.id);
      const cookie = await authCookieFor(caller.id);

      const plain = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", cookie)
        .set("Accept-Encoding", "identity")
        .expect(200);

      const gzipped = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", cookie)
        .set("Accept-Encoding", "gzip")
        .expect(200);

      expect(gzipped.headers["content-encoding"]).toBe("gzip");
      expect(gzipped.headers["vary"]).toContain("Accept-Encoding");
      // Compressed responses go out chunked, so the plain body's length no
      // longer describes them: the bytes on the wire really are different.
      expect(plain.headers["content-length"]).toBeDefined();
      expect(gzipped.headers["content-length"]).toBeUndefined();

      // Supertest decoded the gzip stream to get here, so the envelope
      // survived the encoding. The cursor is minted per request, so it is the
      // one key two pulls of the same data disagree on.
      const { cursor: gzipCursor, ...gzipEnvelope } = gzipped.body as Record<string, unknown>;
      const { cursor: plainCursor, ...plainEnvelope } = plain.body as Record<string, unknown>;
      expect(gzipEnvelope).toEqual(plainEnvelope);
      expect(typeof gzipCursor).toBe("string");
      expect(typeof plainCursor).toBe("string");
      expect((gzipEnvelope.groupUsers as unknown[]).length).toBeGreaterThan(1);
    });

    it("sends plain JSON when the client does not accept gzip", async () => {
      const caller = await makeUser("Caller");
      await seedGroupFor(caller.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .set("Accept-Encoding", "identity")
        .expect(200);

      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body.reset).toBe(true);
    });

    it("keeps Cache-Control: no-store on the compressed response", async () => {
      const caller = await makeUser("Caller");
      await seedGroupFor(caller.id);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .set("Accept-Encoding", "gzip")
        .expect(200);

      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("leaves the rest of the API uncompressed", async () => {
      const caller = await makeUser("Caller");
      for (let index = 0; index < 6; index++) {
        const groupId = await makeGroup(`Group ${index.toString()}`, caller.id);
        await addMember(groupId, caller.id, { viewAccess: true });
      }
      const cookie = await authCookieFor(caller.id);

      const other = await request(app)
        .get("/api/group")
        .set("Cookie", cookie)
        .set("Accept-Encoding", "gzip")
        .expect(200);

      // Past the default threshold, so a `compression()` mounted globally
      // would have compressed this and failed the assertion below.
      expect(JSON.stringify(other.body).length).toBeGreaterThan(COMPRESSION_DEFAULT_THRESHOLD);
      expect(other.headers["content-encoding"]).toBeUndefined();
    });

    it("answers a session signed the way /api/dev/session signs one", async () => {
      const caller = await makeUser("Dev Login Caller");
      await seedGroupFor(caller.id);

      // The dev router is not mounted here — `config.dev` is undefined without
      // `DEV_TOOLS_ENABLED` — so the shared minting path in
      // `utils/devSession.ts`, which is all `/api/dev/session` adds a cookie
      // around, stands in for the route.
      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", await authCookieFor(caller.id))
        .set("Accept-Encoding", "gzip")
        .expect(200);

      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.body.reset).toBe(true);
      expect((res.body.groupUsers as unknown[]).length).toBeGreaterThan(1);
    });

    it("answers a web session from better-auth's own sign-in", async () => {
      const caller = await createWebUser("Web Caller");
      await seedGroupFor(caller.id);
      const cookie = await webSessionCookieFor(app, caller.email);

      const res = await request(app)
        .get("/api/sync/pull")
        .set("Cookie", cookie)
        .set("Accept-Encoding", "gzip")
        .expect(200);

      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.body.reset).toBe(true);
      expect((res.body.groupUsers as unknown[]).length).toBeGreaterThan(1);
    });

    it("carries the same rate-limit headers as any other API route", async () => {
      const caller = await makeUser("Caller");
      await seedGroupFor(caller.id);
      const cookie = await authCookieFor(caller.id);

      const other = await request(app).get("/api/group").set("Cookie", cookie).expect(200);
      const pull = await request(app).get("/api/sync/pull").set("Cookie", cookie).expect(200);

      // The sync router adds no limiter of its own, so the pull is bounded by
      // the same `/api` limiters as everything else and says so identically.
      // Only the budget is comparable: remaining counts down and reset is a
      // seconds countdown, so both move between two sequential requests.
      const names = rateLimitHeaderNames(pull);
      expect(names.length).toBeGreaterThan(0);
      expect(names).toEqual(rateLimitHeaderNames(other));
      expect(pull.headers["ratelimit-limit"]).toBe(other.headers["ratelimit-limit"]);
      expect(pull.headers["ratelimit-policy"]).toBe(other.headers["ratelimit-policy"]);
    });
  });
});
