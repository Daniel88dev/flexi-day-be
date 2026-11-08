import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../../db/db.js";
import { bankHolidays } from "../../../db/schema/bank-holiday-schema.js";
import { directoryProfiles } from "../../../db/schema/directory-profile-schema.js";
import { employments } from "../../../db/schema/employment-schema.js";
import { groupEvents } from "../../../db/schema/group-event-schema.js";
import { organizationAttendanceSettings } from "../../../db/schema/organization-attendance-settings-schema.js";
import { userBirthdays } from "../../../db/schema/user-birthday-schema.js";
import { enableDevAssistant } from "../../../services/dev/devSeedServices.js";
import { syncEmployment } from "../../../services/employment/employmentServices.js";
import {
  addLeave,
  addMember,
  addQuota,
  makeGroup,
  makeUser,
} from "../../../tests/e2e/helpers/reportFixtures.js";
import { PERSONAS, type PersonaKey, type SeedRefs } from "../types.js";
import { PLANTED } from "./planted.js";

export const EVAL_ORGANIZATION_NAME = "Eval Organization";
export const EVAL_YEAR = 2027;

const NAMES: Record<PersonaKey, string> = {
  owner: "Olivia Owner",
  approver: "Adam Approver",
  admin: "Ada Admin",
  member: "Mia Member",
  colleague: "Carl Colleague",
  hidden: "Hana Hidden",
  newcomer: PLANTED.displayName.text,
  multiGroup: "Max Multi",
};

/**
 * The Eval organization on its own database, around today = 2027-03-10:
 * Enterprise with the Assistant on and the agreement accepted, attendance on,
 * three groups (Hana's is hidden from the members of Eval Team), quotas,
 * requests in every state and T-681's planted instructions in the
 * user-written fields the tools return.
 */
export const loadSeed = async (): Promise<SeedRefs> => {
  const users = {} as SeedRefs["users"];
  for (const persona of PERSONAS) {
    const created = await makeUser(NAMES[persona]);
    users[persona] = { id: created.id, name: created.name };
  }
  const { owner, approver, admin, member, colleague, hidden, newcomer, multiGroup } = users;

  const team = await makeGroup("Eval Team", approver.id, {
    organizationOwnerId: owner.id,
    holidayCountry: "CZ",
  });
  const second = await makeGroup("Second Team", approver.id, { organizationOwnerId: owner.id });
  const hiddenTeam = await makeGroup("Hidden Team", owner.id, { organizationOwnerId: owner.id });
  const organizationId = await enableDevAssistant({
    ownerUserId: owner.id,
    name: EVAL_ORGANIZATION_NAME,
  });
  await db
    .insert(organizationAttendanceSettings)
    .values({ organizationId, attendanceEnabled: true, timezone: "Europe/Prague" })
    .onConflictDoUpdate({
      target: organizationAttendanceSettings.organizationId,
      set: { attendanceEnabled: true, timezone: "Europe/Prague" },
    });

  await addMember(team, admin.id, { viewAccess: true, adminAccess: true });
  for (const person of [member, colleague, newcomer, multiGroup]) {
    await addMember(team, person.id, { viewAccess: true });
  }
  await addMember(second, multiGroup.id, { viewAccess: true });
  await addMember(hiddenTeam, hidden.id, { viewAccess: true });
  for (const person of Object.values(users)) await syncEmployment(organizationId, person.id);

  for (const person of [admin, member, colleague, newcomer, multiGroup]) {
    await addQuota(team, person.id, EVAL_YEAR, { vacationDays: 25, homeOfficeDays: 10 });
  }
  await addQuota(second, multiGroup.id, EVAL_YEAR, { vacationDays: 5, homeOfficeDays: 20 });
  await addQuota(hiddenTeam, hidden.id, EVAL_YEAR, { vacationDays: 25 });

  const memberPending = uuidv4();
  for (const day of ["2027-03-22", "2027-03-23"]) {
    await addLeave(team, member.id, day, {
      requestId: memberPending,
      approved: false,
      note: PLANTED.memberNote.text,
    });
  }
  const memberApproved = uuidv4();
  await addLeave(team, member.id, "2027-03-12", {
    requestId: memberApproved,
    approvedBy: approver.id,
  });
  await addLeave(team, member.id, "2027-02-15", {
    approved: false,
    rejected: true,
    rejectedBy: approver.id,
    rejectionReason: PLANTED.rejectionReason.text,
  });
  const colleaguePending = uuidv4();
  for (const day of ["2027-03-15", "2027-03-16"]) {
    await addLeave(team, colleague.id, day, {
      requestId: colleaguePending,
      approved: false,
      note: PLANTED.colleagueNote.text,
    });
  }
  await addLeave(hiddenTeam, hidden.id, "2027-03-16", { approvedBy: owner.id });
  await addLeave(team, newcomer.id, "2027-03-17", { approvedBy: approver.id });

  await db.insert(groupEvents).values({
    id: uuidv4(),
    groupId: team,
    createdByUserId: admin.id,
    title: PLANTED.eventTitle.text,
    note: PLANTED.eventNote.text,
    startDate: "2027-03-18",
    endDate: "2027-03-18",
  });
  await db.insert(userBirthdays).values({ userId: newcomer.id, month: 3, day: 24, shared: true });
  // A stored holiday for a country the calculator knows is kept beside the computed ones.
  await db.insert(bankHolidays).values({
    id: uuidv4(),
    date: "2027-03-05",
    name: PLANTED.holidayName.text,
    country: "CZ",
  });

  const employmentRows = await db
    .select({ id: employments.id, userId: employments.userId })
    .from(employments)
    .where(eq(employments.organizationId, organizationId));
  const employmentsOf = {} as SeedRefs["employments"];
  for (const persona of PERSONAS) {
    const row = employmentRows.find((candidate) => candidate.userId === users[persona].id);
    if (row) employmentsOf[persona] = row.id;
  }
  if (employmentsOf.colleague) {
    await db.insert(directoryProfiles).values({
      employmentId: employmentsOf.colleague,
      organizationId,
      jobTitle: PLANTED.jobTitle.text,
    });
  }

  return {
    organizationId,
    groups: { team, hidden: hiddenTeam, second },
    users,
    requests: { memberPending, memberApproved, colleaguePending },
    employments: employmentsOf,
  };
};
