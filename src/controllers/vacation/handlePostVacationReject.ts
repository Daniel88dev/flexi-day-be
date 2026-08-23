import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { z } from "zod";
import type { ValidatedRejectVacationType } from "../../services/vacation/types.js";
import { rejectRequest } from "../../services/vacation/vacationTransitions.js";

const validateUUID = z.uuid();

export const handlePostVacationReject = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = validateUUID.parse(req.params.id);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const body: ValidatedRejectVacationType = req.body ?? {};

  await rejectRequest({ auth, vacationId, reason: body.reason ?? null });

  return res.status(200).json({ message: "Vacation rejected" });
};
