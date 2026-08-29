import type { Request, Response } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import {
  addMember,
  addVacation,
  findTeam,
  generatePassword,
  seedTeam,
  seedUser,
  setQuota,
  workingDayFromToday,
  type SeededUser,
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

/**
 * Seeds a whole team the UI can actually be exercised against: an owner who is
 * also an admin and approver, three members (Alice approves but administers
 * nothing), current-year quotas, and vacations spread across pending /
 * approved / rejected so every dashboard widget and the approvals queue have
 * content. Re-running it is a no-op rather than an error.
 */
export const handlePostDevScenario = async (req: Request, res: Response) => {
  const data = req.body as ValidatedPostDevScenarioType;
  const domain = config.dev?.seedEmailDomain ?? "dev.local";

  const teamName = data.teamName ?? "Dev Team";
  // One password for the whole team so the response is usable as-is when
  // signing in through the real form.
  const password = data.password ?? generatePassword();

  const owner = await seedUser({
    email: data.ownerEmail ?? `owner@${domain}`,
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

  const bookings = [
    { user: owner, day: workingDayFromToday(-21), state: "approved" as const },
    { user: owner, day: workingDayFromToday(-14), state: "approved" as const },
    { user: owner, day: workingDayFromToday(7), state: "pending" as const },
    { user: alice, day: workingDayFromToday(-7), state: "approved" as const },
    { user: alice, day: workingDayFromToday(3), state: "pending" as const },
    { user: alice, day: workingDayFromToday(4), state: "pending" as const },
    { user: bob, day: workingDayFromToday(0), state: "approved" as const },
    { user: bob, day: workingDayFromToday(10), state: "pending" as const },
    { user: bob, day: workingDayFromToday(-3), state: "rejected" as const },
    { user: carol, day: workingDayFromToday(5), state: "approved" as const },
    {
      user: carol,
      day: workingDayFromToday(1),
      state: "approved" as const,
      type: CalendarRecordType.HomeOffice,
    },
  ];

  let created = 0;
  for (const booking of bookings) {
    const id = await addVacation({
      userId: booking.user.id,
      groupId: team.id,
      requestedDay: booking.day,
      state: booking.state,
      type: booking.type,
      actorUserId: owner.id,
    });
    if (id) created += 1;
  }

  return res.status(201).json({
    team,
    owner,
    members,
    vacationsCreated: created,
    signInUrl: `${config.email.appUrl}/dev-sign-in/?email=${encodeURIComponent(owner.email)}`,
  });
};
