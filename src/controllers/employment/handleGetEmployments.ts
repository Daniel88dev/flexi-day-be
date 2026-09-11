import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { resolveRosterAudience } from "../../services/employment/attendanceAccess.js";
import { listEmployments } from "../../services/employment/employmentServices.js";
import { validateEmploymentQuery } from "../../services/employment/types.js";

/**
 * An organization's roster, scoped to what the caller may read: everyone for
 * an org admin, their groups' members for a group admin, 403 for anyone else.
 *
 * Ended Employments stay in the list and carry `ended: true` — a former
 * colleague's attendance is still the admin's to look at.
 */
export const handleGetEmployments = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { organizationId } = validateEmploymentQuery.parse(req.query);

  const audience = await resolveRosterAudience(auth.userId, organizationId);

  const employments = await listEmployments(
    organizationId,
    audience.everyone ? undefined : { userIds: audience.userIds }
  );

  return res.status(200).json(employments);
};
