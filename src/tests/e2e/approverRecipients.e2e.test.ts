import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { inArray } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { notifications } from "../../db/schema/notification-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { createServer } from "../../server.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { cleanupTestData, createTestUser, type TestUser } from "./helpers/testSetup.js";

type SentEmail = { to: string; template: string };
const sentEmails: SentEmail[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: SentEmail) => {
      sentEmails.push(email);
      return Promise.resolve();
    },
  },
}));

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const firstMondayOfDecember = () => {
  const day = new Date(Date.UTC(new Date().getUTCFullYear(), 11, 1));
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
};
const MONDAY = firstMondayOfDecember();
const MON = isoDay(MONDAY);
const TUE = isoDay(new Date(MONDAY.getTime() + 24 * 60 * 60 * 1000));

/**
 * Who hears about a request: the main and temp approver, members with approver
 * access and the group's manager, never the requester and never whoever acted.
 * The same set reaches email and the in-app bell.
 */
describe("approver recipients", () => {
  let app: Express;
  let manager: TestUser;
  let mainApprover: TestUser;
  let tempApprover: TestUser;
  let accessApprover: TestUser;
  let plainMember: TestUser;
  let requester: TestUser;
  let everyone: TestUser[];

  const makeGroup = async (approvers: { main?: string; temp?: string } = {}) => {
    const organization = await ensureOrganizationForUser(manager.id);
    const id = uuidv4();
    await db.insert(groups).values({
      id,
      organizationId: organization.id,
      groupName: "Recipients",
      managerUserId: manager.id,
      mainApprovalUser: approvers.main ?? null,
      tempApprovalUser: approvers.temp ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  };

  const join = async (
    groupId: string,
    userId: string,
    flags: { adminAccess?: boolean; approverAccess?: boolean }
  ) => {
    await db.insert(groupUsers).values({
      id: uuidv4(),
      groupId,
      userId,
      controlledUser: true,
      adminAccess: flags.adminAccess ?? false,
      approverAccess: flags.approverAccess ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  const fullGroup = async () => {
    const groupId = await makeGroup({ main: mainApprover.id, temp: tempApprover.id });
    await join(groupId, accessApprover.id, { approverAccess: true });
    await join(groupId, plainMember.id, {});
    await join(groupId, requester.id, {});
    return groupId;
  };

  const emailedTo = () => sentEmails.map((email) => email.to).sort();

  const notifiedIds = async () =>
    (
      await db
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(
          inArray(
            notifications.userId,
            everyone.map((u) => u.id)
          )
        )
    )
      .map((n) => n.userId)
      .sort();

  const idsOf = (...users: TestUser[]) => users.map((u) => u.id).sort();
  const emailsOf = (...users: TestUser[]) => users.map((u) => u.email).sort();

  beforeAll(async () => {
    app = createServer();
    manager = await createTestUser("manager@recipients.test", "Mia Manager", "password123");
    mainApprover = await createTestUser("main@recipients.test", "Max Main", "password123");
    tempApprover = await createTestUser("temp@recipients.test", "Tia Temp", "password123");
    accessApprover = await createTestUser("access@recipients.test", "Ari Access", "password123");
    plainMember = await createTestUser("plain@recipients.test", "Pat Plain", "password123");
    requester = await createTestUser("requester@recipients.test", "Rey Requester", "password123");
    everyone = [manager, mainApprover, tempApprover, accessApprover, plainMember, requester];
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(vacation);
    await db.delete(groupUsers);
    await db.delete(groups);
    await db.delete(notifications);
    sentEmails.length = 0;
  });

  it("asks main, temp, approver-access members and the manager about a new request", async () => {
    const groupId = await fullGroup();

    await request(app)
      .post("/api/vacation/create-vacation")
      .set("Cookie", await authCookieFor(requester.id))
      .send({ groupId, from: MON, to: MON })
      .expect(201);

    const approvers = [manager, mainApprover, tempApprover, accessApprover];
    expect(emailedTo()).toEqual(emailsOf(...approvers));
    expect(await notifiedIds()).toEqual(idsOf(...approvers));
  });

  it("asks the manager of a group with no other approver", async () => {
    const groupId = await makeGroup();
    await join(groupId, requester.id, {});

    await request(app)
      .post("/api/vacation/create-vacation")
      .set("Cookie", await authCookieFor(requester.id))
      .send({ groupId, from: MON, to: MON })
      .expect(201);

    expect(emailedTo()).toEqual(emailsOf(manager));
    expect(await notifiedIds()).toEqual(idsOf(manager));
  });

  it("never tells the manager about a request they booked on a member's behalf", async () => {
    const groupId = await fullGroup();
    // The usual shape: the manager also holds a membership with every flag set.
    await join(groupId, manager.id, { adminAccess: true, approverAccess: true });

    await request(app)
      .post("/api/vacation/create-vacation")
      .set("Cookie", await authCookieFor(manager.id))
      .send({ groupId, from: MON, to: MON, userId: requester.id })
      .expect(201);

    const approvers = [mainApprover, tempApprover, accessApprover];
    expect(emailedTo()).toEqual(emailsOf(...approvers));
    // The member gets the in-app "booked on your behalf" notice, not an email.
    expect(await notifiedIds()).toEqual(idsOf(...approvers, requester));
  });

  it("tells the same set when a member bulk-cancels their approved days", async () => {
    const groupId = await fullGroup();
    const ids = [MON, TUE].map(() => uuidv4());
    const requestId = uuidv4();
    await db.insert(vacation).values(
      [MON, TUE].map((day, i) => ({
        id: ids[i]!,
        userId: requester.id,
        groupId,
        requestId,
        requestedDay: day,
        approvedAt: new Date(),
        approvedBy: mainApprover.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    );

    await request(app)
      .post("/api/vacation/cancel")
      .set("Cookie", await authCookieFor(requester.id))
      .send({ ids })
      .expect(200);

    const approvers = [manager, mainApprover, tempApprover, accessApprover];
    expect(emailedTo()).toEqual(emailsOf(...approvers));
    expect(await notifiedIds()).toEqual(idsOf(...approvers));
  });
});
