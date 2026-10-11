import AppError from "../../utils/appError.js";
import { CALENDAR_SYNC_TEAM_SCOPE } from "./types.js";

export const teamScopeError = (context: Record<string, unknown>) =>
  new AppError({
    code: 400,
    message: "Only a calendar with your own records can sync to a connected account",
    publicContext: { code: CALENDAR_SYNC_TEAM_SCOPE },
    context,
  });
