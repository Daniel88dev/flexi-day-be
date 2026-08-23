import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedCommentVacationType } from "../../services/vacation/types.js";
import { commentOnRequest } from "../../services/vacation/vacationTransitions.js";

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

  await commentOnRequest({ auth, vacationId, message: body.message });

  return res.status(200).json({ message: "Comment added" });
};
