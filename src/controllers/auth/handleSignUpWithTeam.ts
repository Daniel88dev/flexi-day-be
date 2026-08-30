import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { eq, or } from "drizzle-orm";
import { auth } from "../../utils/auth.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { user, verification } from "../../db/schema/auth-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { logger } from "../../middleware/logger.js";
import { currentYear } from "../../utils/dateFunc.js";
import { createGroup } from "../../services/group/groupServices.js";
import { createGroupUser } from "../../services/groupUser/groupUserServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { openQuotaFromGroupDefaults } from "../../services/userYearQuotas/userYearQuotasServices.js";

export const validateSignUpWithTeam = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
  password: z.string().min(8).max(256),
  // Optional: an account may exist with no group at all. Without one the user
  // simply cannot book time off until they create or join a group — booking is
  // authorized per-membership in `handlePostVacation`.
  teamName: z
    .string()
    .max(120)
    .transform((value) => value.trim())
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export type ValidatedSignUpWithTeamType = z.infer<typeof validateSignUpWithTeam>;

/**
 * Best-effort cleanup of an auth user we just provisioned via better-auth when
 * downstream local persistence (group / membership) fails. With cascade FKs on
 * `session.userId` and `account.userId`, deleting the user row clears those.
 * `verification` rows are keyed by the email (`identifier`), so we wipe them
 * separately. Failures here are logged but never re-thrown — the caller is
 * already on an error path and the original cause is what matters.
 *
 * We match the user row on (id OR email): id is the fast primary-key path,
 * email is the fallback the malformed-success branch must rely on when
 * better-auth returned 2xx but no parseable user id. `user.email` is uniquely
 * indexed, so this is at most one row.
 */
const rollbackAuthUser = async (userId: string, email: string) => {
  try {
    await db.delete(user).where(or(eq(user.id, userId), eq(user.email, email)));
    await db.delete(verification).where(eq(verification.identifier, email));
  } catch (cleanupErr) {
    logger.error("sign-up-with-team rollback failed", {
      userId,
      email,
      error: cleanupErr,
    });
  }
};

export const handleSignUpWithTeam = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedSignUpWithTeamType = req.body;

  const signUpResult = await auth.api.signUpEmail({
    body: {
      name: data.name,
      email: data.email,
      password: data.password,
    },
    headers: fromNodeHeaders(req.headers),
    asResponse: true,
  });

  if (!signUpResult.ok) {
    const errorPayload = (await signUpResult.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new AppError({
      message: errorPayload?.message ?? "Failed to sign up",
      logging: true,
      code: signUpResult.status,
      context: { email: data.email },
    });
  }

  const signUpPayload = (await signUpResult.json().catch(() => null)) as {
    user?: { id: string };
    token?: string | null;
  } | null;

  const userId = signUpPayload?.user?.id;
  if (!userId) {
    // Auth user state here is unknown — better-auth returned 2xx without a
    // parseable body. Treat as a hard failure and try to compensate using the
    // email we know we sent.
    await rollbackAuthUser("", data.email);
    throw new AppError({
      message: "Sign up succeeded but user id is missing",
      logging: true,
      code: 500,
    });
  }

  const teamName = data.teamName;

  let group: Awaited<ReturnType<typeof createTeamForUser>> | null;
  try {
    group = teamName === undefined ? null : await createTeamForUser(userId, teamName);
  } catch (err) {
    await rollbackAuthUser(userId, data.email);
    throw err;
  }

  // Local persistence is committed — only NOW is it safe to forward
  // better-auth's session cookies onto the response. Doing this earlier would
  // sign the user in even when we end up returning an error.
  signUpResult.headers.forEach((value, key) => {
    res.appendHeader(key, value);
  });

  logger.info("sign-up completed", {
    userId,
    groupId: group?.id ?? null,
  });

  return res.status(201).json({
    user: signUpPayload?.user,
    token: signUpPayload?.token ?? null,
    group,
  });
};

const createTeamForUser = async (userId: string, teamName: string) =>
  db.transaction(async (tx) => {
    const organization = await ensureOrganizationForUser(userId, tx);

    const newGroup = await createGroup(
      {
        id: generateRandomUUID(),
        organizationId: organization.id,
        groupName: teamName,
        managerUserId: userId,
        mainApprovalUser: userId,
      },
      tx
    );

    if (!newGroup) {
      throw new AppError({
        message: "Failed to create team for new user",
        logging: true,
        code: 500,
        context: { userId, teamName },
      });
    }

    const membership = await createGroupUser(
      {
        id: generateRandomUUID(),
        userId,
        groupId: newGroup.id,
        viewAccess: true,
        adminAccess: true,
        approverAccess: true,
        controlledUser: true,
      },
      tx
    );

    if (!membership) {
      throw new AppError({
        message: "Failed to attach new user to their team",
        logging: true,
        code: 500,
        context: { userId, groupId: newGroup.id },
      });
    }

    await openQuotaFromGroupDefaults(
      {
        id: generateRandomUUID(),
        userId,
        groupId: newGroup.id,
        relatedYear: currentYear().toString(),
        vacationDays: newGroup.defaultVacationDays,
        homeOfficeDays: newGroup.defaultHomeOfficeDays,
        sickDays: newGroup.defaultSickDays,
      },
      tx
    );

    return newGroup;
  });
