import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { presentEmployment } from "./utils.js";
import AppError from "../../utils/appError.js";
import { assertEmploymentReadable } from "../../services/employment/attendanceAccess.js";
import { getEmployment } from "../../services/employment/employmentServices.js";
import { validateEmploymentQuery } from "../../services/employment/types.js";

/**
 * One Employment — the row attendance will hang off. The caller's own unless
 * they name someone, and naming someone goes through `attendanceAccess`.
 *
 * The guard runs before the lookup, so a caller with no standing gets the same
 * 403 whether or not the person they asked about exists.
 */
export const handleGetEmployment = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { organizationId, userId } = validateEmploymentQuery.parse(req.query);
  const subjectUserId = userId ?? auth.userId;

  if (subjectUserId !== auth.userId) {
    await assertEmploymentReadable(auth.userId, { organizationId, userId: subjectUserId });
  }

  const employment = await getEmployment(organizationId, subjectUserId);

  if (!employment) {
    throw new AppError({
      message: "No employment in this organization",
      logging: true,
      code: 404,
      context: { userId: auth.userId, organizationId, target: subjectUserId },
    });
  }

  return res.status(200).json(presentEmployment(employment));
};
