import crypto from "crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "../../db/db.js";
import { account, user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { changesSchema } from "../../db/schema/changes-schema.js";
import { vacation, vacationType } from "../../db/schema/vacation-schema.js";
import { vacationEvents, vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { createDBServices } from "../DBServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { formatDateToISOString } from "../../utils/dateFunc.js";
import AppError from "../../utils/appError.js";
import { config } from "../../config.js";

const services = createDBServices();

export type SeededUser = {
  id: string;
  email: string;
  name: string;
  password: string;
  created: boolean;
};

const devDomain = (): string => {
  if (!config.dev) throw new AppError({ message: "Dev tools are disabled", code: 404 });
  return config.dev.seedEmailDomain;
};

/**
 * Seeded accounts are confined to one domain so that reset has an exact,
 * verifiable scope — it can never reach an account a developer created by hand.
 */
export const assertSeedEmail = (email: string): void => {
  const domain = devDomain();
  if (!email.toLowerCase().endsWith(`@${domain}`)) {
    throw new AppError({
      message: `Dev seeding is limited to @${domain} addresses`,
      code: 400,
      publicContext: { email, allowedDomain: domain },
    });
  }
};

/** Strong enough that better-auth's pwned-password check would pass it too. */
export const generatePassword = (): string => `Dev-${crypto.randomBytes(9).toString("base64url")}`;

/**
 * Creates a verified, sign-in-ready user without going through
 * `auth.api.signUpEmail`. That path runs the haveIBeenPwned plugin (an outbound
 * HTTPS call that fails offline) and fires a verification email into SES, both
 * useless locally. Hashing with better-auth's own `hashPassword` keeps the
 * credentials valid through the real sign-in form.
 */
export const seedUser = async (input: {
  email: string;
  name?: string;
  password?: string;
}): Promise<SeededUser> => {
  assertSeedEmail(input.email);

  const email = input.email.toLowerCase();
  const name = input.name ?? email.split("@")[0]!;
  const password = input.password ?? generatePassword();

  const [existing] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (existing) {
    // Re-point the credential at the password we are about to report. Without
    // this, re-running the seeder hands back a password that does not open the
    // account it names.
    await db
      .update(account)
      .set({ password: await hashPassword(password), updatedAt: new Date() })
      .where(and(eq(account.userId, existing.id), eq(account.providerId, "credential")));

    return {
      id: existing.id,
      email: existing.email,
      name: existing.name,
      password,
      created: false,
    };
  }

  const userId = generateRandomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      email,
      name,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await tx.insert(account).values({
      id: generateRandomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  return { id: userId, email, name, password, created: true };
};

export const seedTeam = async (input: {
  teamName: string;
  managerUserId: string;
}): Promise<{ id: string; groupName: string }> => {
  const group = await services.group.createGroup({
    id: generateRandomUUID(),
    groupName: input.teamName,
    managerUserId: input.managerUserId,
    mainApprovalUser: input.managerUserId,
  });

  if (!group) {
    throw new AppError({ message: "Failed to create dev team", code: 500, logging: true });
  }

  return { id: group.id, groupName: group.groupName };
};

/** Lets the scenario seeder be re-run without stacking up duplicate teams. */
export const findTeam = async (
  managerUserId: string,
  groupName: string
): Promise<{ id: string; groupName: string } | undefined> => {
  const [row] = await db
    .select({ id: groups.id, groupName: groups.groupName })
    .from(groups)
    .where(and(eq(groups.managerUserId, managerUserId), eq(groups.groupName, groupName)))
    .limit(1);
  return row;
};

export const addMember = async (input: {
  userId: string;
  groupId: string;
  adminAccess?: boolean;
}): Promise<void> => {
  await services.groupUser.createGroupUser({
    id: generateRandomUUID(),
    userId: input.userId,
    groupId: input.groupId,
    viewAccess: true,
    adminAccess: input.adminAccess ?? false,
    controlledUser: true,
  });
};

export const setQuota = async (input: {
  userId: string;
  groupId: string;
  year?: string;
  vacationDays?: number;
  homeOfficeDays?: number;
  carriedOverDays?: number;
}): Promise<void> => {
  await services.userYearQuotas.upsertUserYearQuota({
    id: generateRandomUUID(),
    userId: input.userId,
    groupId: input.groupId,
    relatedYear: input.year ?? String(new Date().getUTCFullYear()),
    vacationDays: input.vacationDays ?? 25,
    homeOfficeDays: input.homeOfficeDays ?? 10,
    carriedOverDays: input.carriedOverDays ?? 3,
  });
};

type VacationState = "pending" | "approved" | "rejected";

export const addVacation = async (input: {
  userId: string;
  groupId: string;
  requestedDay: string;
  state: VacationState;
  type?: vacationType;
  actorUserId?: string;
  note?: string;
}): Promise<string | undefined> => {
  const id = generateRandomUUID();
  const now = new Date();

  const [row] = await db
    .insert(vacation)
    .values({
      id,
      userId: input.userId,
      groupId: input.groupId,
      requestedDay: input.requestedDay,
      vacationType: input.type ?? vacationType.Vacation,
      note: input.note,
      approvedAt: input.state === "approved" ? now : null,
      approvedBy: input.state === "approved" ? input.actorUserId ?? null : null,
      rejectedAt: input.state === "rejected" ? now : null,
      rejectedBy: input.state === "rejected" ? input.actorUserId ?? null : null,
      rejectionReason: input.state === "rejected" ? "Team coverage on that day" : null,
      createdAt: now,
      updatedAt: now,
    })
    // The (user, day) uniqueness makes re-seeding over existing data a no-op
    // rather than an error.
    .onConflictDoNothing()
    .returning();

  if (!row) return undefined;

  const events: (typeof vacationEvents.$inferInsert)[] = [
    {
      id: generateRandomUUID(),
      vacationId: id,
      eventType: vacationEventType.Created,
      actorUserId: input.userId,
      createdAt: now,
    },
  ];
  if (input.state === "approved") {
    events.push({
      id: generateRandomUUID(),
      vacationId: id,
      eventType: vacationEventType.Approved,
      actorUserId: input.actorUserId ?? input.userId,
      createdAt: now,
    });
  }
  if (input.state === "rejected") {
    events.push({
      id: generateRandomUUID(),
      vacationId: id,
      eventType: vacationEventType.Rejected,
      actorUserId: input.actorUserId ?? input.userId,
      reason: "Team coverage on that day",
      createdAt: now,
    });
  }
  await db.insert(vacationEvents).values(events);

  return id;
};

/** ISO date `offset` days from today (UTC), skipped forward off weekends. */
export const workingDayFromToday = (offset: number): string => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + (offset < 0 ? -1 : 1));
  }
  return formatDateToISOString(date);
};

export type ResetSummary = { users: number; groups: number };

/**
 * Deletes only seeded data. Groups go first because `groups.manager_user_id`
 * and the approval columns reference `user` without a cascade, as do
 * `changes.changing_user_id`; everything else hangs off one of those two
 * deletes via ON DELETE CASCADE.
 */
export const resetDevData = async (): Promise<ResetSummary> => {
  const domain = devDomain();
  const devUsers = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) like ${`%@${domain}`}`);

  if (devUsers.length === 0) return { users: 0, groups: 0 };

  const ids = devUsers.map((row) => row.id);

  return db.transaction(async (tx) => {
    await tx.delete(changesSchema).where(inArray(changesSchema.changingUserId, ids));

    const deletedGroups = await tx
      .delete(groups)
      .where(
        or(
          inArray(groups.managerUserId, ids),
          inArray(groups.mainApprovalUser, ids),
          inArray(groups.tempApprovalUser, ids)
        )
      )
      .returning({ id: groups.id });

    const deletedUsers = await tx
      .delete(user)
      .where(inArray(user.id, ids))
      .returning({ id: user.id });

    return { users: deletedUsers.length, groups: deletedGroups.length };
  });
};

export const countSeededUsers = async (): Promise<number> => {
  const domain = devDomain();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(user)
    .where(sql`lower(${user.email}) like ${`%@${domain}`}`);
  return row?.count ?? 0;
};

export const findUserByEmail = async (email: string) => {
  const [row] = await db
    .select()
    .from(user)
    .where(and(eq(user.email, email.toLowerCase())))
    .limit(1);
  return row;
};
