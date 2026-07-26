import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";

const services = createDBServices();

const queryParams = z.object({
  userId: z.string().min(1),
  year: z.coerce.number().int().min(2025).max(2100),
});

/**
 * What last year left over, so the quota dialog can pre-fill this year's
 * carry-over instead of making the admin work it out. Advisory only — the
 * stored value is whatever the admin submits.
 */
export const handleGetCarryOverSuggestion = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const groupId = z.uuid().parse(req.params.groupId);
  const { userId, year } = queryParams.parse(req.query);

  const access = await services.groupUser.getGroupUser(auth.userId, groupId);

  if (!access || !access.adminAccess) {
    throw new AppError({
      message: "No permission for related group",
      logging: true,
      code: 403,
      context: { url: req.url, user: auth.userId, groupId },
    });
  }

  const suggestion = await services.report.getCarryOverSuggestion(userId, groupId, year);

  return res.status(200).json(suggestion);
};
