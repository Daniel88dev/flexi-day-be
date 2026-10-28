import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { readEndedRetention } from "../../services/directory/retentionSchedule.js";
import { resolveRosterAudience } from "../../services/employment/attendanceAccess.js";
import {
  listEmployments,
  unlinkedOpenEmploymentIds,
} from "../../services/employment/employmentServices.js";
import { validateEmploymentQuery } from "../../services/employment/types.js";

/**
 * An organization's roster, scoped to what the caller may read: everyone for
 * an org admin, their groups' members for a group admin, 403 for anyone else.
 *
 * Ended Employments stay in the list and carry `ended: true` — a former
 * colleague's attendance is still the admin's to look at. Org admins also get
 * `noLink` on every row, which the People card and the turn-off dialog read,
 * and `hold` and `nextRemoval` on ended rows, directory on or off.
 */
export const handleGetEmployments = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { organizationId } = validateEmploymentQuery.parse(req.query);

  const audience = await resolveRosterAudience(auth.userId, organizationId);

  if (!audience.everyone) {
    return res
      .status(200)
      .json(await listEmployments(organizationId, { userIds: audience.userIds }));
  }

  const employments = await listEmployments(organizationId);
  const unlinked = await unlinkedOpenEmploymentIds(organizationId);
  const retention = await readEndedRetention(auth.userId, organizationId, employments);
  return res.status(200).json(
    employments.map((row) => ({
      ...row,
      noLink: unlinked.has(row.id),
      ...retention.get(row.id),
    }))
  );
};
