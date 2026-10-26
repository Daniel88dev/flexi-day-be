import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { and, desc, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { directoryRoleAssignments, directoryRole } from "../../db/schema/directory-role-schema.js";
import { directoryProfileHistory } from "../../db/schema/directory-profile-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { purgeRetention } from "../../services/directory/retentionPurge.js";
import { organizationDataStore } from "../../services/organizationData/organizationDataStore.js";
import { directoryPhotos } from "../../db/schema/directory-photo-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, enableEnterpriseDirectory, errorCode as code } from "./helpers/directoryWorld.js";

const DAY = 24 * 60 * 60 * 1000;
const later = (days: number) => new Date(Date.now() + days * DAY);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const aPhoto = () =>
  sharp({ create: { width: 800, height: 600, channels: 3, background: "#4f2f6f" } })
    .jpeg()
    .toBuffer();

const FILLED = {
  card: { jobTitle: "Accountant" },
  workContact: { workEmail: "jana@work.test", workPhone: "+420 777 000 111" },
  job: { legalName: "Jana Nováková", contractType: "PERMANENT" },
  contact: {
    privatePhone: "+420 777 123 456",
    privateEmail: "jana@home.test",
    emergencyContact1: { name: "Petr Novák", phone: "+420 602 111 222" },
  },
  personal: {
    homeAddress: { line1: "Dlouhá 12", city: "Praha", country: "CZ" },
    dateOfBirth: "1990-04-17",
  },
};

describe("Copy from previous spell", () => {
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
   * Olga owns the organization and manages Support. In Support: Jana (a
   * member who leaves and comes back), Dana (org-admin grant), Hana (HR) and
   * Mira (a member).
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const dana = await makeUser("Dana Delegate");
    const hana = await makeUser("Hana Human");
    const mira = await makeUser("Mira Member");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, dana, hana, mira]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    await enableEnterpriseDirectory(organizationId, owner.id);
    const openEmploymentOf = async (userId: string) => {
      const [row] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(and(eq(employments.userId, userId), eq(employments.organizationId, organizationId)))
        .orderBy(desc(employments.startedAt))
        .limit(1);
      return row!.id;
    };
    await db.insert(directoryRoleAssignments).values({
      employmentId: await openEmploymentOf(hana.id),
      role: directoryRole.Hr,
      organizationId,
      assignedByUserId: owner.id,
    });
    const people = (path = "") => `/api/directory/${organizationId}/people${path}`;
    return {
      organizationId,
      support,
      users: { owner, jana, dana, hana, mira },
      openEmploymentOf,
      path: (employmentId: string) => people(`/${employmentId}`),
      previous: (employmentId: string) => people(`/${employmentId}/previous-spell`),
      copy: (employmentId: string) => people(`/${employmentId}/previous-spell/copy`),
      show: (employmentId: string, section: "contact" | "personal") =>
        people(`/${employmentId}/show/${section}`),
    };
  };
  type Fixture = Awaited<ReturnType<typeof setUp>>;

  const as = (userId: string) => apiAs(server.url, userId);

  /** A store URL points at the configured API origin; send it to the test server instead. */
  const local = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };

  const uploadPhoto = async (fixture: Fixture, employmentId: string) => {
    const owner = await as(fixture.users.owner.id);
    const bytes = await aPhoto();
    const requested = await owner.post(fixture.path(employmentId) + "/photo", {
      contentType: "image/jpeg",
      size: bytes.length,
    });
    expect(requested.status).toBe(201);
    const target = requested.body.upload as { url: string; headers: Record<string, string> };
    const sent = await request(server.url).put(local(target.url)).set(target.headers).send(bytes);
    expect(sent.body.status).toBe("READY");
    return requested.body.photo.id as string;
  };

  const photoFiles = async (employmentId: string) => {
    const [row] = await db
      .select()
      .from(directoryPhotos)
      .where(eq(directoryPhotos.employmentId, employmentId));
    if (!row) return undefined;
    const prefix = `photos/${row.organizationId}/${employmentId}/${row.id}/`;
    return {
      row,
      small: await organizationDataStore!.getObject(`${prefix}small.jpg`),
      full: await organizationDataStore!.getObject(`${prefix}full.jpg`),
    };
  };

  /** Jana fills every Section, leaves, and joins Support again: two spells. */
  const rejoin = async (fixture: Fixture, { photo = false } = {}) => {
    const { users } = fixture;
    const owner = await as(users.owner.id);
    const first = await fixture.openEmploymentOf(users.jana.id);
    expect((await owner.patch(fixture.path(first), FILLED)).status).toBe(200);
    if (photo) await uploadPhoto(fixture, first);
    const ended = await owner.post(`/api/employment/${first}/end`, {
      endedOn: isoDay(new Date()),
    });
    expect(ended.status).toBe(200);
    await addMember(fixture.support, users.jana.id);
    await syncEmployment(fixture.organizationId, users.jana.id);
    const second = await fixture.openEmploymentOf(users.jana.id);
    expect(second).not.toBe(first);
    return { first, second };
  };

  describe("the copy", () => {
    it("brings the chosen Sections over to the new spell and records them in its history", async () => {
      const fixture = await setUp();
      const { first, second } = await rejoin(fixture);
      const owner = await as(fixture.users.owner.id);

      const copied = await owner.post(fixture.copy(second), { sections: ["contact"] });
      expect(copied.status).toBe(200);
      expect(copied.body.employmentId).toBe(second);

      const contact = await owner.post(fixture.show(second, "contact"));
      expect(contact.status).toBe(200);
      expect(contact.body).toMatchObject({
        privatePhone: { e164: "+420777123456" },
        privateEmail: "jana@home.test",
        emergencyContact1: { name: "Petr Novák", phone: { e164: "+420602111222" } },
        emergencyContact2: null,
      });
      const personal = await owner.post(fixture.show(second, "personal"));
      expect(personal.body).toMatchObject({ homeAddress: null, dateOfBirth: null });

      const [sealed] = await db
        .select()
        .from(directorySensitiveProfiles)
        .where(eq(directorySensitiveProfiles.employmentId, second));
      const [old] = await db
        .select()
        .from(directorySensitiveProfiles)
        .where(eq(directorySensitiveProfiles.employmentId, first));
      expect(sealed!.contact).not.toBe(old!.contact);
      expect(sealed!.contact).not.toContain("jana@home.test");

      const history = await db
        .select()
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, second));
      expect(history).toEqual([
        expect.objectContaining({
          section: "CONTACT",
          fields: ["privatePhone", "privateEmail", "emergencyContact1"],
          actor: "PERSON",
          actorUserId: fixture.users.owner.id,
          audience: "OWNER",
        }),
      ]);
    });

    it("copies Personal and the Profile photo as new files, and never Card, Work contact or Job", async () => {
      const fixture = await setUp();
      const { first, second } = await rejoin(fixture, { photo: true });
      const owner = await as(fixture.users.owner.id);

      const copied = await owner.post(fixture.copy(second), { sections: ["personal", "photo"] });
      expect(copied.status).toBe(200);
      expect(copied.body.sections.card).toMatchObject({ jobTitle: null });
      expect(copied.body.sections.workContact).toMatchObject({ workEmail: null, workPhone: null });
      expect(copied.body.sections.job).toMatchObject({ legalName: null, contractType: null });
      expect(decodeURIComponent(copied.body.sections.photo.photo.fullUrl)).toContain(`/${second}/`);

      const personal = await owner.post(fixture.show(second, "personal"));
      expect(personal.body).toMatchObject({
        homeAddress: { line1: "Dlouhá 12", city: "Praha", country: { code: "CZ" } },
        dateOfBirth: "1990-04-17",
      });
      const contact = await owner.post(fixture.show(second, "contact"));
      expect(contact.body).toMatchObject({ privatePhone: null, privateEmail: null });

      const before = await photoFiles(first);
      const after = await photoFiles(second);
      expect(after!.row).toMatchObject({
        status: "READY",
        uploadedByUserId: fixture.users.owner.id,
      });
      expect(after!.row.id).not.toBe(before!.row.id);
      expect(after!.full!.equals(before!.full!)).toBe(true);
      expect(after!.small!.equals(before!.small!)).toBe(true);

      const history = await owner.get(fixture.path(second) + "/history");
      expect(history.status).toBe(200);
      expect(
        history.body.map((entry: { section: string; fields: string[] }) => [
          entry.section,
          entry.fields,
        ])
      ).toEqual(
        expect.arrayContaining([
          ["PHOTO", ["photo"]],
          ["PERSONAL", ["homeAddress", "dateOfBirth"]],
        ])
      );
      expect(history.body).toHaveLength(2);
    });

    it("refuses a Section the spell already holds, and the Sections the copy never takes", async () => {
      const fixture = await setUp();
      const { second } = await rejoin(fixture);
      const owner = await as(fixture.users.owner.id);
      const typed = await owner.patch(fixture.path(second), {
        contact: { privateEmail: "new@home.test" },
      });
      expect(typed.status).toBe(200);

      const filled = await owner.post(fixture.copy(second), { sections: ["contact", "personal"] });
      expect(filled.status).toBe(409);
      expect(code(filled)).toBe("SECTION_ALREADY_FILLED");
      const personal = await owner.post(fixture.show(second, "personal"));
      expect(personal.body).toMatchObject({ homeAddress: null, dateOfBirth: null });

      const card = await owner.post(fixture.copy(second), { sections: ["card"] });
      expect(card.status).toBe(422);
      const empty = await owner.post(fixture.copy(second), { sections: [] });
      expect(empty.status).toBe(422);

      const preview = await owner.get(fixture.previous(second));
      expect(preview.body.sections).toEqual({
        contact: { status: "FILLED" },
        personal: { status: "COPYABLE" },
        photo: { status: "EMPTY" },
      });
    });
  });

  describe("what retention left", () => {
    it("shows what retention removed and copies only what is still held", async () => {
      const fixture = await setUp();
      const { first, second } = await rejoin(fixture, { photo: true });
      const owner = await as(fixture.users.owner.id);

      expect(await purgeRetention(later(31))).toBe(2);

      const preview = await owner.get(fixture.previous(second));
      expect(preview.status).toBe(200);
      expect(preview.body.previous).toMatchObject({ employmentId: first });
      expect(preview.body.sections).toEqual({
        contact: { status: "REMOVED_ON", date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
        personal: { status: "COPYABLE" },
        photo: { status: "COPYABLE" },
      });

      const gone = await owner.post(fixture.copy(second), { sections: ["contact", "photo"] });
      expect(gone.status).toBe(409);
      expect(code(gone)).toBe("SECTION_NOT_HELD");
      expect(await photoFiles(second)).toBeUndefined();

      const kept = await owner.post(fixture.copy(second), { sections: ["personal", "photo"] });
      expect(kept.status).toBe(200);
      expect(kept.body.actions.copyFromPreviousSpell).toBe(false);
    });

    it("skips Personal on an External worker's spell", async () => {
      const fixture = await setUp();
      const { second } = await rejoin(fixture);
      const owner = await as(fixture.users.owner.id);
      const changed = await owner.put(fixture.path(second) + "/worker-type", { type: "external" });
      expect(changed.status).toBe(200);

      const preview = await owner.get(fixture.previous(second));
      expect(preview.body.sections).toEqual({
        contact: { status: "COPYABLE" },
        photo: { status: "EMPTY" },
      });
      const refused = await owner.post(fixture.copy(second), { sections: ["personal"] });
      expect(refused.status).toBe(422);
      expect(code(refused)).toBe("EMPLOYEES_ONLY");
      expect((await owner.post(fixture.copy(second), { sections: ["contact"] })).status).toBe(200);
    });
  });

  describe("the previous spell", () => {
    it("is the latest ended spell of the same user", async () => {
      const fixture = await setUp();
      const { second } = await rejoin(fixture);
      const owner = await as(fixture.users.owner.id);
      expect((await owner.post(fixture.copy(second), { sections: ["contact"] })).status).toBe(200);
      expect(
        (await owner.post(`/api/employment/${second}/end`, { endedOn: isoDay(new Date()) })).status
      ).toBe(200);
      await addMember(fixture.support, fixture.users.jana.id);
      await syncEmployment(fixture.organizationId, fixture.users.jana.id);
      const third = await fixture.openEmploymentOf(fixture.users.jana.id);

      const preview = await owner.get(fixture.previous(third));
      expect(preview.body.previous.employmentId).toBe(second);
      expect(preview.body.sections).toMatchObject({
        contact: { status: "COPYABLE" },
        personal: { status: "EMPTY" },
      });

      const firstSpell = await owner.get(
        fixture.previous(await fixture.openEmploymentOf(fixture.users.mira.id))
      );
      expect(firstSpell.status).toBe(404);
      expect(code(firstSpell)).toBe("NO_PREVIOUS_SPELL");
    });

    it("is found by email when no account is bound", async () => {
      const fixture = await setUp();
      const owner = await as(fixture.users.owner.id);
      const people = `/api/directory/${fixture.organizationId}/people`;
      const added = await owner.post(people, {
        name: "Ada Noaccount",
        type: "employee",
        email: "ada@example.test",
      });
      expect(added.status).toBe(201);
      const first = added.body.employmentId as string;
      expect((await owner.patch(fixture.path(first), { contact: FILLED.contact })).status).toBe(
        200
      );
      expect(
        (await owner.post(`/api/employment/${first}/end`, { endedOn: isoDay(new Date()) })).status
      ).toBe(200);

      const stranger = await owner.post(people, {
        name: "Ada Other",
        type: "employee",
        email: "other@example.test",
      });
      expect(code(await owner.get(fixture.previous(stranger.body.employmentId)))).toBe(
        "NO_PREVIOUS_SPELL"
      );

      const again = await owner.post(people, {
        name: "Ada Noaccount",
        type: "employee",
        email: "ADA@example.test",
      });
      expect(again.status).toBe(201);
      const second = again.body.employmentId as string;
      expect(again.body.actions.copyFromPreviousSpell).toBe(true);
      const preview = await owner.get(fixture.previous(second));
      expect(preview.body.previous.employmentId).toBe(first);
      expect(preview.body.sections.contact).toEqual({ status: "COPYABLE" });
      expect((await owner.post(fixture.copy(second), { sections: ["contact"] })).status).toBe(200);
      const contact = await owner.post(fixture.show(second, "contact"));
      expect(contact.body).toMatchObject({ privateEmail: "jana@home.test" });
    });
    it("finds a spell without an account for a person who comes back with one", async () => {
      const fixture = await setUp();
      const owner = await as(fixture.users.owner.id);
      const added = await owner.post(`/api/directory/${fixture.organizationId}/people`, {
        name: "Ada Noaccount",
        type: "employee",
        email: "ada@example.test",
      });
      const first = added.body.employmentId as string;
      expect((await owner.patch(fixture.path(first), { contact: FILLED.contact })).status).toBe(
        200
      );
      expect(
        (await owner.post(`/api/employment/${first}/end`, { endedOn: isoDay(new Date()) })).status
      ).toBe(200);

      const ada = await makeUser("Ada Account");
      await db.update(user).set({ email: "ada@example.test" }).where(eq(user.id, ada.id));
      await addMember(fixture.support, ada.id);
      await syncEmployment(fixture.organizationId, ada.id);
      const second = await fixture.openEmploymentOf(ada.id);

      const preview = await owner.get(fixture.previous(second));
      expect(preview.body.previous.employmentId).toBe(first);
      expect(preview.body.sections.contact).toEqual({ status: "COPYABLE" });
    });
  });

  describe("who copies", () => {
    it("offers the banner to the owner, org admins and HR only", async () => {
      const fixture = await setUp();
      const { first, second } = await rejoin(fixture);
      const { owner, dana, hana, mira } = fixture.users;
      const offered = async (userId: string, employmentId: string) => {
        const res = await (await as(userId)).get(fixture.path(employmentId));
        return res.status === 200 ? res.body.actions.copyFromPreviousSpell : res.status;
      };

      expect(await offered(owner.id, second)).toBe(true);
      expect(await offered(dana.id, second)).toBe(true);
      expect(await offered(hana.id, second)).toBe(true);
      expect(await offered(mira.id, second)).toBe(false);
      expect(await offered(owner.id, first)).toBe(false);
      expect(await offered(owner.id, await fixture.openEmploymentOf(mira.id))).toBe(false);

      const member = await as(mira.id);
      expect(code(await member.get(fixture.previous(second)))).toBe("COPY_DENIED");
      const denied = await member.post(fixture.copy(second), { sections: ["contact"] });
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe("COPY_DENIED");

      const hr = await as(hana.id);
      const copied = await hr.post(fixture.copy(second), { sections: ["contact", "personal"] });
      expect(copied.status).toBe(200);
      expect(copied.body.actions.copyFromPreviousSpell).toBe(false);
      const history = await db
        .select()
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, second));
      expect(history).toHaveLength(2);
      expect(history.every((row) => row.actorUserId === hana.id && row.audience === "HR")).toBe(
        true
      );
      expect(await offered(owner.id, second)).toBe(false);
    });

    it("refuses the copy on a lapsed plan and still shows the dialog", async () => {
      const fixture = await setUp();
      const { second } = await rejoin(fixture);
      await upsertSubscription(fixture.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      const owner = await as(fixture.users.owner.id);

      expect((await owner.get(fixture.previous(second))).status).toBe(200);
      const lapsed = await owner.post(fixture.copy(second), { sections: ["contact"] });
      expect(lapsed.status).toBe(402);
      const contact = await owner.post(fixture.show(second, "contact"));
      expect(contact.body).toMatchObject({ privatePhone: null, privateEmail: null });
    });
  });
});
