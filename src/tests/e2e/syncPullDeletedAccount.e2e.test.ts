import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import {
  addMember,
  ageEverything,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

type UserRow = {
  id: string;
  name: string;
  image: string | null;
  accountDeleted: boolean;
  updatedAt: string;
};

const MEMBER = "Jana Nováková";

describe("Sync pull of a Deleted account", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await resetReportData();
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  const organizationOf = async (groupId: string): Promise<string> =>
    (await db.select().from(groups).where(eq(groups.id, groupId)))[0]!.organizationId;

  /** A group in a fresh organization where the caller sees everyone and the member is employed. */
  const employIn = async (
    groupName: string,
    caller: { id: string },
    member: { id: string }
  ): Promise<string> => {
    const owner = await makeUser(`${groupName} Owner`);
    const groupId = await makeGroup(groupName, owner.id);
    await addMember(groupId, caller.id, { viewAccess: true });
    await addMember(groupId, member.id);
    const organizationId = await organizationOf(groupId);
    await syncEmployment(organizationId, member.id);
    return organizationId;
  };

  const deleteAccount = async (email: string): Promise<void> => {
    const cookie = await webSessionCookieFor(server.url, email);
    await request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD })
      .expect(204);
  };

  const pulledUser = async (callerId: string, userId: string, cursor?: string) => {
    const res = await request(server.url)
      .get("/api/sync/pull")
      .query(cursor ? { cursor } : {})
      .set("Cookie", await authCookieFor(callerId))
      .expect(200);
    return (res.body.users as UserRow[]).find((row) => row.id === userId);
  };

  const setCopy = async (organizationId: string, userId: string, name: string, updatedAt: Date) => {
    await db
      .update(employments)
      .set({ name, updatedAt })
      .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)));
  };

  it("sends the frozen name, no image and accountDeleted", async () => {
    const caller = await makeUser("Caller");
    const member = await createWebUser(MEMBER);
    await db
      .update(user)
      .set({ image: "https://example.test/jana.png" })
      .where(eq(user.id, member.id));
    await employIn("Acme", caller, member);

    await deleteAccount(member.email);

    const [stored] = await db.select().from(user).where(eq(user.id, member.id));
    expect(await pulledUser(caller.id, member.id)).toEqual({
      id: member.id,
      name: MEMBER,
      image: null,
      accountDeleted: true,
      updatedAt: stored!.updatedAt.toISOString(),
    });
  });

  it("marks a live account as not deleted", async () => {
    const caller = await makeUser("Caller");
    const member = await makeUser(MEMBER);
    await employIn("Acme", caller, member);

    expect(await pulledUser(caller.id, member.id)).toMatchObject({
      name: MEMBER,
      accountDeleted: false,
    });
  });

  it("takes the copy of the most recently updated Employment the caller shares", async () => {
    const caller = await makeUser("Caller");
    const member = await createWebUser(MEMBER);
    const acme = await employIn("Acme", caller, member);
    const globex = await employIn("Globex", caller, member);
    await deleteAccount(member.email);

    await setCopy(acme, member.id, "Jana Acme", new Date("2026-01-01T00:00:00Z"));
    await setCopy(globex, member.id, "Jana Globex", new Date("2026-02-01T00:00:00Z"));
    expect((await pulledUser(caller.id, member.id))?.name).toBe("Jana Globex");

    await setCopy(acme, member.id, "Jana Acme", new Date("2026-03-01T00:00:00Z"));
    expect((await pulledUser(caller.id, member.id))?.name).toBe("Jana Acme");
  });

  it("ignores the copy in an organization the caller does not share", async () => {
    const caller = await makeUser("Caller");
    const stranger = await makeUser("Stranger");
    const member = await createWebUser(MEMBER);
    const acme = await employIn("Acme", caller, member);
    const initech = await employIn("Initech", stranger, member);
    await deleteAccount(member.email);

    await setCopy(acme, member.id, "Jana Acme", new Date("2026-01-01T00:00:00Z"));
    await setCopy(initech, member.id, "Jana Initech", new Date("2026-02-01T00:00:00Z"));

    expect((await pulledUser(caller.id, member.id))?.name).toBe("Jana Acme");
  });

  it("reads Deleted account once no shared Employment is left", async () => {
    const caller = await makeUser("Caller");
    const member = await createWebUser(MEMBER);
    await employIn("Acme", caller, member);
    await deleteAccount(member.email);

    await db.delete(employments).where(eq(employments.userId, member.id));

    expect(await pulledUser(caller.id, member.id)).toMatchObject({
      name: "Deleted account",
      accountDeleted: true,
    });
  });

  it("carries the stripped row on a delta that started before the deletion", async () => {
    const caller = await makeUser("Caller");
    const member = await createWebUser(MEMBER);
    await employIn("Acme", caller, member);
    await ageEverything();
    const cursor = encodeSyncCursor(new Date(Date.now() - 60 * 1000));

    await deleteAccount(member.email);

    expect(await pulledUser(caller.id, member.id, cursor)).toMatchObject({
      name: MEMBER,
      image: null,
      accountDeleted: true,
    });
  });
});
