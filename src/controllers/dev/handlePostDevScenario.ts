import type { Request, Response } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import {
  addMember,
  addVacation,
  findTeam,
  generatePassword,
  nextWorkingDay,
  seedTeam,
  seedUser,
  setQuota,
  workingDayFromToday,
  type SeededUser,
  type VacationState,
} from "../../services/dev/devSeedServices.js";

export const validatePostDevScenario = z.object({
  teamName: z.string().min(1).max(120).optional(),
  ownerEmail: z.email().optional(),
  password: z.string().min(8).max(256).optional(),
});

export type ValidatedPostDevScenarioType = z.infer<typeof validatePostDevScenario>;

const MEMBERS = [
  { local: "alice", name: "Alice Novak", approverAccess: true },
  { local: "bob", name: "Bob Dvorak" },
  { local: "carol", name: "Carol Svoboda" },
];

type ScenarioBooking = {
  user: SeededUser;
  day: string;
  state: VacationState;
  type?: CalendarRecordType;
  requestId?: string;
};

const seedBookings = async (
  groupId: string,
  actorUserId: string,
  bookings: ScenarioBooking[]
): Promise<number> => {
  let created = 0;
  for (const booking of bookings) {
    const id = await addVacation({
      userId: booking.user.id,
      groupId,
      requestedDay: booking.day,
      state: booking.state,
      type: booking.type,
      actorUserId,
      requestId: booking.requestId,
    });
    if (id) created += 1;
  }
  return created;
};

const ADMINISTERED_TEAM = "Dev Support";
const ADMINISTERED_MANAGER = { local: "dave", name: "Dave Horak" };
const ADMINISTERED_MEMBERS = [
  { local: "erin", name: "Erin Kral", vacationDays: 20, homeOfficeDays: 5 },
  { local: "frank", name: "Frank Benes", vacationDays: 25, homeOfficeDays: 10 },
];

/**
 * Seeds a whole team the UI can actually be exercised against: an owner who is
 * also an admin and approver, three members (Alice approves but administers
 * nothing), current-year quotas, and vacations spread across pending /
 * approved / rejected so every dashboard widget and the approvals queue have
 * content. A second team in the owner's organization, run by Dave, has the
 * owner as org admin but not as a member, for the "Groups you administer"
 * views. Re-running it is a no-op rather than an error.
 */
export const handlePostDevScenario = async (req: Request, res: Response) => {
  const data = req.body as ValidatedPostDevScenarioType;
  const domain = config.dev?.seedEmailDomain ?? "dev.local";

  const teamName = data.teamName ?? "Dev Team";
  // One password for the whole team so the response is usable as-is when
  // signing in through the real form.
  const password = data.password ?? generatePassword();

  const ownerEmail = (data.ownerEmail ?? `owner@${domain}`).toLowerCase();
  const reserved = [...MEMBERS, ADMINISTERED_MANAGER, ...ADMINISTERED_MEMBERS].map(
    (member) => `${member.local}@${domain}`
  );
  if (reserved.includes(ownerEmail)) {
    throw new AppError({
      message: "ownerEmail is reserved for another scenario account",
      code: 400,
      publicContext: { ownerEmail, reserved },
    });
  }

  const owner = await seedUser({
    email: ownerEmail,
    name: "Olivia Owner",
    password,
  });

  const team =
    (await findTeam(owner.id, teamName)) ?? (await seedTeam({ teamName, managerUserId: owner.id }));

  await addMember({ userId: owner.id, groupId: team.id, adminAccess: true, approverAccess: true });
  await setQuota({ userId: owner.id, groupId: team.id });

  const members: SeededUser[] = [];
  for (const member of MEMBERS) {
    const seeded = await seedUser({
      email: `${member.local}@${domain}`,
      name: member.name,
      password,
    });
    await addMember({
      userId: seeded.id,
      groupId: team.id,
      approverAccess: member.approverAccess ?? false,
    });
    await setQuota({ userId: seeded.id, groupId: team.id });
    members.push(seeded);
  }

  const [alice, bob, carol] = members as [SeededUser, SeededUser, SeededUser];

  const aliceRange = generateRandomUUID();
  const aliceStart = workingDayFromToday(3);
  const bookings: ScenarioBooking[] = [
    { user: owner, day: workingDayFromToday(-21), state: "approved" },
    { user: owner, day: workingDayFromToday(-14), state: "approved" },
    { user: owner, day: workingDayFromToday(7), state: "pending" },
    { user: alice, day: workingDayFromToday(-7), state: "approved" },
    { user: alice, day: aliceStart, state: "pending", requestId: aliceRange },
    {
      user: alice,
      day: nextWorkingDay(aliceStart),
      state: "pending",
      requestId: aliceRange,
    },
    { user: bob, day: workingDayFromToday(0), state: "approved" },
    { user: bob, day: workingDayFromToday(10), state: "pending" },
    { user: bob, day: workingDayFromToday(-3), state: "rejected" },
    { user: carol, day: workingDayFromToday(5), state: "approved" },
    {
      user: carol,
      day: workingDayFromToday(1),
      state: "approved",
      type: CalendarRecordType.HomeOffice,
    },
  ];

  const teamBookingsCreated = await seedBookings(team.id, owner.id, bookings);

  const manager = await seedUser({
    email: `${ADMINISTERED_MANAGER.local}@${domain}`,
    name: ADMINISTERED_MANAGER.name,
    password,
  });
  const organization = await ensureOrganizationForUser(owner.id);
  const administeredTeam =
    (await findTeam(manager.id, ADMINISTERED_TEAM, organization.id)) ??
    (await seedTeam({
      teamName: ADMINISTERED_TEAM,
      managerUserId: manager.id,
      organizationId: organization.id,
    }));

  await addMember({
    userId: manager.id,
    groupId: administeredTeam.id,
    adminAccess: true,
    approverAccess: true,
  });
  await setQuota({ userId: manager.id, groupId: administeredTeam.id });

  const administeredMembers: SeededUser[] = [];
  for (const member of ADMINISTERED_MEMBERS) {
    const seeded = await seedUser({
      email: `${member.local}@${domain}`,
      name: member.name,
      password,
    });
    await addMember({ userId: seeded.id, groupId: administeredTeam.id });
    await setQuota({
      userId: seeded.id,
      groupId: administeredTeam.id,
      vacationDays: member.vacationDays,
      homeOfficeDays: member.homeOfficeDays,
    });
    administeredMembers.push(seeded);
  }

  const [erin, frank] = administeredMembers as [SeededUser, SeededUser];

  const frankRange = generateRandomUUID();
  const frankStart = workingDayFromToday(8);
  const administeredBookings: ScenarioBooking[] = [
    { user: manager, day: workingDayFromToday(-10), state: "approved" },
    { user: manager, day: workingDayFromToday(12), state: "pending" },
    { user: erin, day: workingDayFromToday(-5), state: "approved" },
    { user: erin, day: workingDayFromToday(6), state: "pending" },
    { user: erin, day: workingDayFromToday(-2), state: "rejected" },
    {
      user: frank,
      day: workingDayFromToday(2),
      state: "approved",
      type: CalendarRecordType.HomeOffice,
    },
    { user: frank, day: frankStart, state: "pending", requestId: frankRange },
    {
      user: frank,
      day: nextWorkingDay(frankStart),
      state: "pending",
      requestId: frankRange,
    },
  ];

  const administeredBookingsCreated = await seedBookings(
    administeredTeam.id,
    manager.id,
    administeredBookings
  );

  return res.status(201).json({
    team,
    owner,
    members,
    administeredTeam: { ...administeredTeam, manager, members: administeredMembers },
    vacationsCreated: teamBookingsCreated + administeredBookingsCreated,
    signInUrl: `${config.email.appUrl}/dev-sign-in/?email=${encodeURIComponent(owner.email)}`,
  });
};
