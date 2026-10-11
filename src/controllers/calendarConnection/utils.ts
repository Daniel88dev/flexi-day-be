import { z } from "zod";
import AppError from "../../utils/appError.js";
import {
  CALENDAR_SYNC_PROVIDER_OFF,
  validateCalendarProviderParam,
} from "../../services/calendarConnection/types.js";
import type { calendarProvider } from "../../db/schema/calendar-connection-schema.js";

/** An unknown provider answers 404, the same as one whose switch is off. */
export const parseProvider = (param: unknown): calendarProvider => {
  const parsed = validateCalendarProviderParam.safeParse(param);
  if (!parsed.success) {
    throw new AppError({
      code: 404,
      message: "This calendar provider is not available",
      publicContext: { code: CALENDAR_SYNC_PROVIDER_OFF },
      context: { provider: param },
    });
  }
  return parsed.data;
};

const validateConfigId = z.uuid();

export const parseConfigId = (param: unknown): string => {
  const parsed = validateConfigId.safeParse(param);
  if (!parsed.success) throw new AppError({ code: 400, message: "Invalid calendar id" });
  return parsed.data;
};
