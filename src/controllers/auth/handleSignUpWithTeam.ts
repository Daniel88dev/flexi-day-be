import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "../../utils/auth.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { user, verification } from "../../db/schema/auth-schema.js";
import { createDBServices } from "../../services/DBServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { logger } from "../../middleware/logger.js";

const services = createDBServices();

export const validateSignUpWithTeam = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
  password: z.string().min(8).max(256),
  teamName: z.string().min(1).max(120),
});

export type ValidatedSignUpWithTeamType = z.infer<
  typeof validateSignUpWithTeam
>;

/**
 * Best-effort cleanup of an auth user we just provisioned via better-auth when
 * downstream local persistence (group / membership) fails. With cascade FKs on
 * `session.userId` and `account.userId`, deleting the user row clears those.
 * `verification` rows are keyed by the email (`identifier`), so we wipe them
 * separately. Failures here are logged but never re-thrown — the caller is
 * already on an error path and the original cause is what matters.
 */
const rollbackAuthUser = async (userId: string, email: string) => {
  try {
    await db.delete(user).where(eq(user.id, userId));
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
    const errorPayload = (await signUpResult.json().catch(() => null)) as
      | { message?: string }
      | null;
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

  let group;
  try {
    group = await db.transaction(async (tx) => {
      const newGroup = await services.group.createGroup(
        {
          id: generateRandomUUID(),
          groupName: data.teamName,
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
          context: { userId, teamName: data.teamName },
        });
      }

      const membership = await services.groupUser.createGroupUser(
        {
          id: generateRandomUUID(),
          userId,
          groupId: newGroup.id,
          viewAccess: true,
          adminAccess: true,
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

      return newGroup;
    });
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

  logger.info("sign-up-with-team completed", {
    userId,
    groupId: group.id,
  });

  return res.status(201).json({
    user: signUpPayload?.user,
    token: signUpPayload?.token ?? null,
    group,
  });
};
