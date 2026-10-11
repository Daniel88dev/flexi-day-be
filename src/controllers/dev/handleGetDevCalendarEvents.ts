import type { Request, Response } from "express";
import { z } from "zod";
import { dumpDevCalendarEvents } from "../../services/dev/devCalendarServices.js";

const validateGetDevCalendarEvents = z.object({ email: z.email().optional() });

export const handleGetDevCalendarEvents = async (req: Request, res: Response) => {
  const { email } = validateGetDevCalendarEvents.parse(req.query);
  return res.status(200).json(await dumpDevCalendarEvents(email));
};
