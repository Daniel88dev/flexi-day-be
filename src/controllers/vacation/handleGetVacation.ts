import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { getRequestDetail } from "../../services/vacation/requestReads.js";

export const handleGetVacation = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const vacationId = z.uuid().parse(req.params.id);

  const detail = await getRequestDetail({ auth, vacationId });

  return res.status(200).json(detail);
};
