import type { Request, Response } from "express";
import { z } from "zod";
import { calendarCapability } from "../../db/schema/calendar-connection-schema.js";
import { validateCalendarProviderParam } from "../../services/calendarConnection/types.js";
import { setDevCalendarCapability } from "../../services/dev/devCalendarServices.js";

export const validatePostDevCalendarCapability = z.object({
  email: z.email(),
  provider: validateCalendarProviderParam.optional(),
  capability: z.enum(calendarCapability),
});

type ValidatedPostDevCalendarCapability = z.infer<typeof validatePostDevCalendarCapability>;

export const handlePostDevCalendarCapability = async (req: Request, res: Response) => {
  const data = req.body as ValidatedPostDevCalendarCapability;
  return res.status(200).json(await setDevCalendarCapability(data));
};
