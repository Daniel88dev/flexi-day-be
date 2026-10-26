import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { eq, sql } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { getEmployment } from "../../services/employment/employmentServices.js";
import { createGroup } from "../../services/group/groupServices.js";
import {
  createGroupUser,
  deleteGroupUser,
  getGroupUser,
} from "../../services/groupUser/groupUserServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";

const NAME_COPY_MIGRATION = "src/db/schema/out/0032_employments_name_copy.sql";

/** The backfill as the deploy runs it, taken out of the migration rather than restated. */
const backfillNameCopy = async () => {
  const migration = await readFile(resolve(process.cwd(), NAME_COPY_MIGRATION), "utf8");
  const statement = migration
    .split("--> statement-breakpoint")
    .find((part) => part.trim().startsWith('UPDATE "employments"'));

  if (!statement) throw new Error(`${NAME_COPY_MIGRATION} no longer carries the backfill`);

  await db.execute(sql.raw(statement));
};

/**
 * The Employment's own copy of the person's name and email: written when it
 * opens, kept in step with the account while it is open, frozen once it ends.
 */
describe("the Employment's name and email copy", () => {
  let server: LoopbackServer;
  let organizationId: string;
  let owner: { id: string; name: string; email: string };
  let groupId: string;

  const userOf = async (slug: string) =>
    createTestUser(`name-copy-${slug}@test.com`, `Name Copy ${slug}`, "password123");

  const join = async (userId: string) =>
    createGroupUser({ id: uuidv4(), groupId, userId, viewAccess: true, controlledUser: true });

  const leave = async (userId: string) => {
    const membership = await getGroupUser(userId, groupId);
    await deleteGroupUser(membership!.id);
  };

  const copyOf = async (userId: string) => {
    const employment = await getEmployment(organizationId, userId);
    return { name: employment?.name, email: employment?.email, ended: !!employment?.endedAt };
  };

  const rename = (userId: string, name: string) =>
    request(server.url)
      .post("/api/auth/update-user")
      .set("Cookie", cookieOf.get(userId)!)
      .set("Origin", "http://localhost:3000")
      .send({ name });

  const cookieOf = new Map<string, string>();

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
    owner = await userOf("owner");
    organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const group = await createGroup({
      id: uuidv4(),
      organizationId,
      groupName: "Name Copy Team",
      managerUserId: owner.id,
    });
    groupId = group!.id;
  });

  afterAll(async () => {
    await server.close();
    await cleanupTestData();
  });

  describe("opening", () => {
    it("copies the account's name and email onto a new Employment", async () => {
      expect(await copyOf(owner.id)).toEqual({
        name: "Name Copy owner",
        email: "name-copy-owner@test.com",
        ended: false,
      });
    });

    it("copies the account as it is now when an ended Employment reopens", async () => {
      const returner = await userOf("returner");
      await join(returner.id);
      await leave(returner.id);
      await db.update(user).set({ name: "Name Copy renamed" }).where(eq(user.id, returner.id));

      await join(returner.id);

      expect(await copyOf(returner.id)).toEqual({
        name: "Name Copy renamed",
        email: "name-copy-returner@test.com",
        ended: false,
      });
    });
  });

  describe("an account change", () => {
    it("rewrites the copy on every open Employment when the person renames themselves", async () => {
      const member = await userOf("renamer");
      await join(member.id);
      const otherOwner = await userOf("other-owner");
      const otherOrganizationId = (await ensureOrganizationForUser(otherOwner.id)).id;
      const otherGroup = await createGroup({
        id: uuidv4(),
        organizationId: otherOrganizationId,
        groupName: "Name Copy Elsewhere",
        managerUserId: otherOwner.id,
      });
      await createGroupUser({
        id: uuidv4(),
        groupId: otherGroup!.id,
        userId: member.id,
        viewAccess: true,
        controlledUser: true,
      });
      cookieOf.set(member.id, await authCookieFor(member.id));

      const response = await rename(member.id, "Name Copy Nováková");

      expect(response.status).toBe(200);
      expect((await copyOf(member.id)).name).toBe("Name Copy Nováková");
      expect((await getEmployment(otherOrganizationId, member.id))?.name).toBe(
        "Name Copy Nováková"
      );
    });

    it("leaves an ended Employment with the name it had when it ended", async () => {
      const leaver = await userOf("leaver");
      await join(leaver.id);
      await leave(leaver.id);
      cookieOf.set(leaver.id, await authCookieFor(leaver.id));

      expect((await rename(leaver.id, "Name Copy later")).status).toBe(200);

      expect(await copyOf(leaver.id)).toEqual({
        name: "Name Copy leaver",
        email: "name-copy-leaver@test.com",
        ended: true,
      });
    });

    it("follows an email change on open Employments and not on ended ones", async () => {
      const stayer = await userOf("email-stayer");
      const leaver = await userOf("email-leaver");
      await join(stayer.id);
      await join(leaver.id);
      await leave(leaver.id);

      await db
        .update(user)
        .set({ email: "name-copy-email-stayer-new@test.com" })
        .where(eq(user.id, stayer.id));
      await db
        .update(user)
        .set({ email: "name-copy-email-leaver-new@test.com" })
        .where(eq(user.id, leaver.id));

      expect((await copyOf(stayer.id)).email).toBe("name-copy-email-stayer-new@test.com");
      expect((await copyOf(leaver.id)).email).toBe("name-copy-email-leaver@test.com");
    });

    it("rolls the copy back with the account change it followed", async () => {
      const member = await userOf("rollback");
      await join(member.id);

      await expect(
        db.transaction(async (tx) => {
          await tx.update(user).set({ name: "Name Copy never" }).where(eq(user.id, member.id));
          expect((await getEmployment(organizationId, member.id, tx))?.name).toBe(
            "Name Copy never"
          );
          throw new Error("roll back");
        })
      ).rejects.toThrow("roll back");

      expect((await copyOf(member.id)).name).toBe("Name Copy rollback");
    });
  });

  describe("the deploy backfill", () => {
    it("copies every Employment's name and email from its account", async () => {
      const member = await userOf("backfill");
      await join(member.id);
      await db
        .update(employments)
        .set({ name: "stale", email: null })
        .where(eq(employments.userId, member.id));

      await backfillNameCopy();

      expect(await copyOf(member.id)).toEqual({
        name: "Name Copy backfill",
        email: "name-copy-backfill@test.com",
        ended: false,
      });
    });
  });
});
