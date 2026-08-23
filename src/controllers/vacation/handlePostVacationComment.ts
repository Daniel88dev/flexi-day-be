import type { Request, Response } from "express";
import { z } from "zod";
import { createDBServices } from "../../services/DBServices.js";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { db } from "../../db/db.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { notifyVacationComment } from "../../services/vacation/vacationNotifier.js";
import { resolveVacationPermissions } from "../../services/vacation/vacationPermissions.js";
import { assertGroupWritable } from "../../services/billing/guards.js";
import type { ValidatedCommentVacationType } from "../../services/vacation/types.js";

const services = createDBServices();

/**
 * Appends a comment to a request timeline without changing its decision. Any
 * caller who can view the request may comment; the other party is notified
 * after the row commits (best-effort — a mail failure never fails the comment).
 */
export const handlePostVacationComment = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = z.uuid().parse(req.params.id);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body: ValidatedCommentVacationType = req.body;

  const commented = await db.transaction(async (tx) => {
    const vacationData = await services.vacation.getVacationById(vacationId, tx);
    if (!vacationData) {
      throw new AppError({
        code: 404,
        message: "Vacation not found",
        context: { auth, vacationId },
      });
    }

    const permissions = await resolveVacationPermissions(auth.userId, vacationData, tx);
    if (!permissions.canView) {
      throw new AppError({
        code: 403,
        message: "You are not allowed to comment on this vacation",
        logging: true,
        context: { userId: auth.userId, vacationId },
      });
    }

    await assertGroupWritable(vacationData.groupId, tx);

    await services.vacationEvent.createVacationEvent(
      {
        id: generateRandomUUID(),
        vacationId,
        eventType: vacationEventType.Comment,
        actorUserId: auth.userId,
        reason: body.message,
      },
      tx
    );

    return vacationData;
  });

  // Post-commit and best-effort: notify the other party of the new comment.
  await notifyVacationComment(commented, { id: auth.userId, name: auth.userName }, body.message);

  return res.status(200).json({ message: "Comment added" });
};
