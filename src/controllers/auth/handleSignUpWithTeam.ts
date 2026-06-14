import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { auth } from "../../utils/auth.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
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

  signUpResult.headers.forEach((value, key) => {
    res.appendHeader(key, value);
  });

  const signUpPayload = (await signUpResult.json().catch(() => null)) as {
    user?: { id: string };
    token?: string | null;
  } | null;

  const userId = signUpPayload?.user?.id;
  if (!userId) {
    throw new AppError({
      message: "Sign up succeeded but user id is missing",
      logging: true,
      code: 500,
    });
  }

  const group = await db.transaction(async (tx) => {
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
