import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import type { ValidatedCancelVacationType } from "../../services/vacation/types.js";
import { cancelRequest } from "../../services/vacation/vacationTransitions.js";

const validateUUID = z.uuid();

/**
 * Cancels (soft deletes) a request. Owners can withdraw their own bookings —
 * approved ones included — and group admins / approvers can cancel on their
 * behalf. The cancellation is recorded on the timeline so who did it and why
 * survives beyond the row's `deletedAt` stamp.
 */
export const handleDeleteVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body: ValidatedCancelVacationType = req.body ?? {};

  await cancelRequest({ auth, vacationId, reason: body.reason ?? null });

  return res.status(200).json({ message: "Vacation cancelled" });
};
