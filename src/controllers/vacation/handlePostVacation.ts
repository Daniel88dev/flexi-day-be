import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import type { ValidatedPostVacationType } from "../../services/vacation/types.js";
import { createRequest } from "../../services/vacation/requestCreation.js";

export const handlePostVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const input: ValidatedPostVacationType = req.body;

  const created = await createRequest({ auth, input });

  return res.status(201).json(created);
};
