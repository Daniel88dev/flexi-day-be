import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { attachments, AttachmentStatus } from "../../db/schema/attachment-schema.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { createVacationEvent } from "../../services/vacationEvent/vacationEventServices.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  addMirror,
  cancelLeave,
  dayIn,
  makeGroup,
  makeUser,
  removeMember,
  removeMirror,
  resetReportData,
} from "./helpers/reportFixtures.js";

const YEAR = new Date().getFullYear() + 1;
const MONTH = 4;
const day = (d: number) => dayIn(YEAR, MONTH, d);

const attachFile = async (vacationId: string, sourceGroupId: string, ownerUserId: string) => {
  const [row] = await db
    .select({ requestId: vacation.requestId })
    .from(vacation)
    .where(eq(vacation.id, vacationId));
  const [group] = await db
    .select({ organizationId: groups.organizationId })
    .from(groups)
    .where(eq(groups.id, sourceGroupId));
  await db.insert(attachments).values({
    id: uuidv4(),
    requestId: row!.requestId,
    organizationId: group!.organizationId,
    ownerUserId,
    uploadedByUserId: ownerUserId,
    fileName: "dave-private-file.pdf",
    contentType: "application/pdf",
    size: 1024,
    storageKey: `e2e/${uuidv4()}`,
    status: AttachmentStatus.Ready,
  });
};

/**
 * "Source" (Sam manages it, Steve owns its organization) holds Dave's, Erin's
 * and Fay's records; Sue approves there and Sid administers it. Each of the three mirrors Source into
 * "Team" (Mia manages it, Tom owns its organization). Erin has since left Team
 * and Fay's mirror is removed, so only Dave's records still project into Team.
 * Nobody in Team has any standing in Source.
 */
const seed = async () => {
  const tom = await makeUser("Tom Target Owner");
  const mia = await makeUser("Mia Target Manager");
  const viewer = await makeUser("Vera Viewer");
  const teamApprover = await makeUser("Abe Target Approver");
  const teamAdmin = await makeUser("Ada Target Admin");
  const plain = await makeUser("Pat Plain");
  const outsider = await makeUser("Otto Outsider");
  const steve = await makeUser("Steve Source Owner");
  const sam = await makeUser("Sam Source Manager");
  const sue = await makeUser("Sue Source Approver");
  const sid = await makeUser("Sid Source Admin");
  const dave = await makeUser("Dave Mirror");
  const erin = await makeUser("Erin Left");
  const fay = await makeUser("Fay Unmirrored");

  const team = await makeGroup("Team", mia.id, { organizationOwnerId: tom.id });
  await addMember(team, viewer.id, { viewAccess: true });
  await addMember(team, teamApprover.id, { viewAccess: true, approverAccess: true });
  await addMember(team, teamAdmin.id, { adminAccess: true });
  await addMember(team, plain.id);
  for (const member of [dave, erin, fay]) await addMember(team, member.id);

  const source = await makeGroup("Source", sam.id, { organizationOwnerId: steve.id });
  await addMember(source, sue.id, { viewAccess: true, approverAccess: true });
  await addMember(source, sid.id, { adminAccess: true });
  for (const member of [dave, erin, fay]) await addMember(source, member.id, { viewAccess: true });

  await addMirror(dave.id, source, team);
  await addMirror(erin.id, source, team);
  await removeMember(team, erin.id);
  const fayMirror = await addMirror(fay.id, source, team);
  await removeMirror(fayMirror);

  const daveSick = await addLeave(source, dave.id, day(2), {
    type: CalendarRecordType.Sick,
    approved: false,
    note: "dave-sick-note",
  });
  await createVacationEvent({
    id: uuidv4(),
    vacationId: daveSick,
    eventType: vacationEventType.Comment,
    actorUserId: sue.id,
    reason: "dave-private-comment",
  });
  await attachFile(daveSick, source, dave.id);
  const daveRejected = await addLeave(source, dave.id, day(6), {
    approved: false,
    rejected: true,
    rejectedBy: sue.id,
    rejectionReason: "dave-rejection-reason",
  });
  const daveCancelled = await addLeave(source, dave.id, day(8), { note: "dave-cancel-note" });
  await cancelLeave(daveCancelled, dave.id);
  const erinLeave = await addLeave(source, erin.id, day(10));
  const fayLeave = await addLeave(source, fay.id, day(12));

  return {
    tom,
    mia,
    viewer,
    teamApprover,
    teamAdmin,
    plain,
    outsider,
    steve,
    sam,
    sue,
    sid,
    dave,
    team,
    daveSick,
    daveRejected,
    daveCancelled,
    erinLeave,
    fayLeave,
  };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type Reader = (seeded: Seeded) => { id: string };

const PRIVATE_STRINGS = [
  "dave-sick-note",
  "dave-private-comment",
  "dave-private-file",
  "dave-rejection-reason",
  "dave-cancel-note",
];

describe("A record mirrored into a group opens read-only for that group's viewers", () => {
  let server: LoopbackServer;
  let s: Seeded;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
    s = await seed();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  const detail = async (userId: string, vacationId: string) =>
    request(server.url)
      .get(`/api/vacation/${vacationId}`)
      .set("Cookie", await authCookieFor(userId));

  const listIds = async (userId: string, groupId: string) => {
    const res = await request(server.url)
      .get("/api/vacation")
      .query({ year: YEAR, month: MONTH, groupId, includeCancelled: true })
      .set("Cookie", await authCookieFor(userId));
    expect(res.status).toBe(200);
    return (res.body as { id: string }[]).map((row) => row.id);
  };

  const comment = async (userId: string, vacationId: string) =>
    request(server.url)
      .post(`/api/vacation/comment/${vacationId}`)
      .set("Cookie", await authCookieFor(userId))
      .send({ message: "a comment" });

  const targetReaders: [string, Reader][] = [
    ["a View member of the target group", (seeded) => seeded.viewer],
    ["an approver of the target group", (seeded) => seeded.teamApprover],
    ["a group admin of the target group", (seeded) => seeded.teamAdmin],
    ["the target group's manager", (seeded) => seeded.mia],
    ["an org admin of the target organization", (seeded) => seeded.tom],
  ];

  describe.each(targetReaders)("%s, with no standing in the source group", (_, pick) => {
    it("lists the mirrored record and opens it by id in the teammate view", async () => {
      const reader = pick(s).id;
      expect(await listIds(reader, s.team)).toContain(s.daveSick);

      const res = await detail(reader, s.daveSick);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: s.daveSick,
        vacationType: "AWAY",
        note: null,
        rejectionReason: null,
        history: [],
        canReadPrivateDetails: false,
        canApprove: false,
        canCancel: false,
        canEdit: false,
      });
      expect(res.body).not.toHaveProperty("attachments");
      expect(res.body).not.toHaveProperty("canAttach");
      expect(res.body).not.toHaveProperty("canDeleteAnyAttachment");
      const wire = JSON.stringify(res.body);
      for (const secret of PRIVATE_STRINGS) expect(wire).not.toContain(secret);
    });

    it("cannot comment on the mirrored record", async () => {
      const res = await comment(pick(s).id, s.daveSick);

      expect(res.status).toBe(403);
    });

    it("cannot open the owner's rejected or cancelled mirrored records", async () => {
      for (const id of [s.daveRejected, s.daveCancelled]) {
        const res = await detail(pick(s).id, id);
        expect(res.status).toBe(403);
        const wire = JSON.stringify(res.body);
        for (const secret of PRIVATE_STRINGS) expect(wire).not.toContain(secret);
      }
    });
  });

  it("refuses a record whose mirror is removed, as the list leaves it out", async () => {
    expect(await listIds(s.viewer.id, s.team)).not.toContain(s.fayLeave);

    const res = await detail(s.viewer.id, s.fayLeave);

    expect(res.status).toBe(403);
  });

  it("refuses a record whose owner has left the target group, as the list leaves it out", async () => {
    expect(await listIds(s.viewer.id, s.team)).not.toContain(s.erinLeave);

    const res = await detail(s.viewer.id, s.erinLeave);

    expect(res.status).toBe(403);
  });

  it.each<[string, Reader]>([
    ["a member of the target group without View", (seeded) => seeded.plain],
    ["someone in neither group", (seeded) => seeded.outsider],
  ])("refuses %s", async (_, pick) => {
    const res = await detail(pick(s).id, s.daveSick);

    expect(res.status).toBe(403);
  });

  describe.each<[string, Reader]>([
    ["the owner", (seeded) => seeded.dave],
    ["the source group's approver", (seeded) => seeded.sue],
    ["a group admin of the source group", (seeded) => seeded.sid],
    ["the source group's manager", (seeded) => seeded.sam],
    ["an org admin of the source organization", (seeded) => seeded.steve],
  ])("%s keeps the full record", (_, pick) => {
    it("reads Sick, the note, the history and the attachments", async () => {
      const res = await detail(pick(s).id, s.daveSick);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        vacationType: CalendarRecordType.Sick,
        note: "dave-sick-note",
        canReadPrivateDetails: true,
        canCancel: true,
      });
      expect(JSON.stringify(res.body.history)).toContain("dave-private-comment");
      expect(JSON.stringify(res.body.attachments)).toContain("dave-private-file.pdf");
    });

    it("opens the rejected record with its reason", async () => {
      const res = await detail(pick(s).id, s.daveRejected);

      expect(res.status).toBe(200);
      expect(res.body.rejectionReason).toBe("dave-rejection-reason");
    });
  });

  it("lets the source group's approver decide the mirrored record", async () => {
    const res = await detail(s.sue.id, s.daveSick);

    expect(res.body.canApprove).toBe(true);
  });
});
