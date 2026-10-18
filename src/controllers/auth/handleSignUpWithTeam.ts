import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "../../utils/auth.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { verification } from "../../db/schema/auth-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { logger } from "../../middleware/logger.js";
import { currentYear } from "../../utils/dateFunc.js";
import { createGroup } from "../../services/group/groupServices.js";
import { createGroupUser } from "../../services/groupUser/groupUserServices.js";
import {
  deleteUserByIdAndEmail,
  getUserByEmail,
  getUserById,
} from "../../services/user/userServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { openQuotaFromGroupDefaults } from "../../services/userYearQuotas/userYearQuotasServices.js";

export const validateSignUpWithTeam = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
  // better-auth's own limits; it answers a longer password with 400.
  password: z.string().min(8).max(128),
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
 * Best-effort cleanup of a user this request created, when building its team
 * fails. Sessions and the credential account cascade with the row; verification
 * rows are keyed by e-mail, so they go only when the user row did. Failures are
 * logged, not re-thrown: the caller is already on an error path.
 */
const rollbackCreatedUser = async (userId: string, email: string) => {
  try {
    if (await deleteUserByIdAndEmail(userId, email)) {
      await db.delete(verification).where(eq(verification.identifier, email));
    }
  } catch (cleanupErr) {
    logger.error("sign-up-with-team rollback failed", { userId, error: cleanupErr });
  }
};

export const handleSignUpWithTeam = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedSignUpWithTeamType = req.body;
  const email = data.email.toLowerCase();

  // better-auth answers an address that already has an account with a 2xx and
  // a synthetic user that is never saved, so the 2xx alone proves nothing.
  const existedBefore = (await getUserByEmail(email)) !== undefined;

  const signUpResult = await auth.api.signUpEmail({
    body: {
      name: data.name,
      email,
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
      context: { email },
    });
  }

  const signUpPayload = (await signUpResult.json().catch(() => null)) as {
    user?: { id: string };
    token?: string | null;
  } | null;

  const userId = signUpPayload?.user?.id;
  if (!userId) {
    // No id to trust, so nothing is deleted.
    throw new AppError({
      message: "Sign up succeeded but user id is missing",
      logging: true,
      code: 500,
    });
  }

  let createdHere: boolean;
  let group: Awaited<ReturnType<typeof createTeamForUser>> | null = null;
  try {
    createdHere = !existedBefore && (await getUserById(userId))?.email === email;
    if (createdHere && data.teamName !== undefined) {
      group = await createTeamForUser(userId, data.teamName);
    }
  } catch (err) {
    if (!existedBefore) await rollbackCreatedUser(userId, email);
    throw err;
  }

  // Local persistence is committed — only NOW is it safe to forward
  // better-auth's session cookies onto the response. Doing this earlier would
  // sign the user in even when we end up returning an error.
  signUpResult.headers.forEach((value, key) => {
    res.appendHeader(key, value);
  });

  if (createdHere) {
    logger.info("sign-up completed", { userId, groupId: group?.id ?? null });
  } else {
    logger.info("sign-up for an address that already has an account");
  }

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
