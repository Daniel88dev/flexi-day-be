import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, enableEnterpriseDirectory, errorCode as code } from "./helpers/directoryWorld.js";

describe("The Work contact Section", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  /**
   * Olga owns the organization and manages Support. In Support: Jana and Pavel
   * (plain members), Dana (org-admin grant) and Eli (External worker).
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const pavel = await makeUser("Pavel Colleague");
    const dana = await makeUser("Dana Delegate");
    const eli = await makeUser("Eli External");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, pavel, dana, eli]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    await db
      .update(employments)
      .set({ type: workerType.External })
      .where(eq(employments.userId, eli.id));
    await enableEnterpriseDirectory(organizationId, owner.id);
    const [janaEmployment] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(and(eq(employments.userId, jana.id), eq(employments.organizationId, organizationId)));
    const path = `/api/directory/${organizationId}/people/${janaEmployment!.id}`;
    return {
      organizationId,
      users: { owner, jana, pavel, dana, eli },
      janaEmployment: janaEmployment!.id,
      path,
    };
  };

  const as = (userId: string) => apiAs(server.url, userId);

  const fill = async (path: string, ownerId: string) => {
    const res = await (
      await as(ownerId)
    ).patch(path, {
      workContact: { workEmail: "Jana.Work@Example.TEST", workPhone: "+420 601 123 456" },
    });
    expect(res.status).toBe(200);
    return res;
  };

  describe("phones and emails", () => {
    it("stores a work phone in E.164 and the work email in lowercase", async () => {
      const { path, users, janaEmployment } = await setUp();

      const res = await fill(path, users.owner.id);

      expect(res.body.sections.workContact).toEqual({
        level: "WRITE",
        workEmail: "jana.work@example.test",
        workPhone: {
          e164: "+420601123456",
          display: "+420 601 123 456",
          country: { code: "CZ", name: "Czechia" },
        },
        phoneCountryDefault: null,
      });
      const [stored] = await db
        .select({ workEmail: directoryProfiles.workEmail, workPhone: directoryProfiles.workPhone })
        .from(directoryProfiles)
        .where(eq(directoryProfiles.employmentId, janaEmployment));
      expect(stored).toEqual({ workEmail: "jana.work@example.test", workPhone: "+420601123456" });
    });

    it("refuses an invalid phone number and stores nothing", async () => {
      const { path, users, janaEmployment } = await setUp();
      const owner = await as(users.owner.id);

      for (const workPhone of ["+420 601 12", "601 123 456", "+420 601 123 456 ext. 3"]) {
        const res = await owner.patch(path, { workContact: { workPhone } });
        expect(res.status).toBe(422);
        expect(code(res)).toBe("INVALID_PHONE");
      }
      const email = await owner.patch(path, { workContact: { workEmail: "not an email" } });
      expect(email.status).toBe(422);
      const tooLong = await owner.patch(path, {
        workContact: { workEmail: `${"a".repeat(250)}@x.cz` },
      });
      expect(tooLong.status).toBe(422);

      const stored = await db
        .select()
        .from(directoryProfiles)
        .where(eq(directoryProfiles.employmentId, janaEmployment));
      expect(stored).toEqual([]);
    });

    it("names the phone's country in the viewer's language, from the stored setting or the request", async () => {
      const { path, users } = await setUp();
      await fill(path, users.owner.id);
      await db.insert(userSettings).values({ userId: users.pavel.id, language: appLanguage.Czech });
      const pavel = await as(users.pavel.id);

      const stored = await pavel.get(path);
      expect(stored.body.sections.workContact.workPhone.country).toEqual({
        code: "CZ",
        name: "Česko",
      });
      const asked = await pavel.get(`${path}?language=en`);
      expect(asked.body.sections.workContact.workPhone.country.name).toBe("Czechia");
      const owner = await (await as(users.owner.id)).get(`${path}?language=cs`);
      expect(owner.body.sections.workContact.workPhone.country.name).toBe("Česko");
    });

    it("starts the phone country on the interface language for whoever writes Work contact", async () => {
      const { path, users } = await setUp();
      const owner = await as(users.owner.id);

      const czech = await owner.get(`${path}?language=cs`);
      expect(czech.body.sections.workContact.phoneCountryDefault).toEqual({
        code: "CZ",
        name: "Česko",
      });
      const english = await owner.get(`${path}?language=en`);
      expect(english.body.sections.workContact.phoneCountryDefault).toBeNull();
      const reader = await (await as(users.pavel.id)).get(`${path}?language=cs`);
      expect(reader.body.sections.workContact).not.toHaveProperty("phoneCountryDefault");
    });

    it("clears both fields with null", async () => {
      const { path, users } = await setUp();
      await fill(path, users.owner.id);

      const res = await (
        await as(users.owner.id)
      ).patch(path, {
        workContact: { workEmail: null, workPhone: null },
      });

      expect(res.status).toBe(200);
      expect(res.body.sections.workContact).toMatchObject({ workEmail: null, workPhone: null });
    });
  });

  describe("who reads and writes it", () => {
    it("shows Work contact to colleagues, the person and org admins", async () => {
      const { path, users } = await setUp();
      await fill(path, users.owner.id);

      for (const reader of [users.pavel, users.jana, users.dana]) {
        const res = await (await as(reader.id)).get(path);
        expect(res.body.sections.workContact.workEmail).toBe("jana.work@example.test");
        expect(res.body.sections.workContact.workPhone.e164).toBe("+420601123456");
      }
    });

    it("keeps Work contact from an External worker under the default table", async () => {
      const { path, users, organizationId } = await setUp();
      await fill(path, users.owner.id);
      const eli = await as(users.eli.id);

      const profile = await eli.get(path);
      const list = await eli.get(`/api/directory/${organizationId}/people`);

      expect(profile.status).toBe(200);
      expect(profile.body.sections).not.toHaveProperty("workContact");
      for (const body of [profile.text, list.text]) {
        expect(body).not.toContain("jana.work@example.test");
        expect(body).not.toContain("601123456");
        expect(body).not.toContain("601 123 456");
      }
    });

    it("refuses a write from anyone without a Work contact write cell", async () => {
      const { path, users } = await setUp();

      for (const writer of [users.pavel, users.jana, users.eli]) {
        const res = await (
          await as(writer.id)
        ).patch(path, {
          workContact: { workPhone: "+420 601 123 456" },
        });
        expect(res.status).toBe(403);
        expect(code(res)).toBe("SECTION_NOT_WRITABLE");
      }
      const byAdmin = await (
        await as(users.dana.id)
      ).patch(path, {
        workContact: { workPhone: "+420 601 123 456" },
      });
      expect(byAdmin.status).toBe(200);
    });
  });

  describe("the sign-in email", () => {
    it("never reaches a colleague on the list or the profile, and reaches the editors", async () => {
      const { path, users, organizationId } = await setUp();
      await fill(path, users.owner.id);
      const [row] = await db
        .select({ signInEmail: user.email })
        .from(user)
        .where(eq(user.id, users.jana.id));
      const signInEmail = row!.signInEmail;
      expect(signInEmail).toContain("@");
      const pavel = await as(users.pavel.id);

      const profile = await pavel.get(path);
      const list = await pavel.get(`/api/directory/${organizationId}/people`);

      for (const body of [profile.text, list.text]) {
        expect(body).not.toContain(signInEmail);
      }
      const owner = await (await as(users.owner.id)).get(path);
      expect(owner.body.account.signInEmail).toBe(signInEmail);
    });
  });

  describe("plan and history", () => {
    it("refuses setting a value on a lapsed organization and lets clearing through", async () => {
      const { path, users, organizationId } = await setUp();
      await fill(path, users.owner.id);
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      const owner = await as(users.owner.id);

      const set = await owner.patch(path, { workContact: { workPhone: "+420 777 123 456" } });
      expect(set.status).toBe(402);
      const clear = await owner.patch(path, { workContact: { workPhone: null } });
      expect(clear.status).toBe(200);
      expect(clear.body.sections.workContact).toMatchObject({
        workEmail: "jana.work@example.test",
        workPhone: null,
      });
    });

    it("records which Work contact fields changed, and through which audience, never the values", async () => {
      const { path, users, janaEmployment } = await setUp();
      await fill(path, users.owner.id);
      await (
        await as(users.dana.id)
      ).patch(path, {
        workContact: { workEmail: "jana.work@example.test", workPhone: "+420 777 123 456" },
      });

      const rows = await db
        .select({
          section: directoryProfileHistory.section,
          fields: directoryProfileHistory.fields,
          audience: directoryProfileHistory.audience,
        })
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, janaEmployment))
        .orderBy(directoryProfileHistory.createdAt);
      expect(rows).toEqual([
        { section: "WORK_CONTACT", fields: ["workEmail", "workPhone"], audience: "OWNER" },
        { section: "WORK_CONTACT", fields: ["workPhone"], audience: "ORGANIZATION_ADMIN" },
      ]);
      const history = await (await as(users.owner.id)).get(`${path}/history`);
      expect(history.text).not.toContain("777 123 456");
      expect(history.text).not.toContain("777123456");
      expect(history.text).not.toContain("jana.work");
    });
  });
});
