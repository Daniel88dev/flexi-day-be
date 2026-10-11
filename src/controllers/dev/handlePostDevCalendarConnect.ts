import type { Request, Response } from "express";
import { z } from "zod";
import { calendarProvider } from "../../db/schema/calendar-connection-schema.js";
import {
  timeZoneSchema,
  validateCalendarProviderParam,
} from "../../services/calendarConnection/types.js";
import {
  connectDevCalendar,
  DEFAULT_DEV_TIME_ZONE,
} from "../../services/dev/devCalendarServices.js";

export const validatePostDevCalendarConnect = z.object({
  email: z.email(),
  configId: z.uuid().optional(),
  provider: validateCalendarProviderParam.default(calendarProvider.Google),
  timeZone: timeZoneSchema.default(DEFAULT_DEV_TIME_ZONE),
});

type ValidatedPostDevCalendarConnect = z.infer<typeof validatePostDevCalendarConnect>;

export const handlePostDevCalendarConnect = async (req: Request, res: Response) => {
  const data = req.body as ValidatedPostDevCalendarConnect;
  return res.status(201).json(await connectDevCalendar(data));
};
