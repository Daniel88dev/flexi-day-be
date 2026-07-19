import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import AppError from "../../utils/appError.js";
import { validateCreateCalendarSync } from "../../services/calendarSync/types.js";
import { feedBaseUrl, resolveTeamIds, serializeConfig } from "./utils.js";

const services = createDBServices();

/** Creates a calendar-sync config and returns it with a freshly-minted token. */
export const handlePostCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const data = validateCreateCalendarSync.parse(req.body);

  const userGroups = await services.groupUser.getAllGroupsForUser(auth.userId);
  const userGroupIds = new Set(userGroups.map((g) => g.groupId));

  const teamIds = resolveTeamIds(data, userGroupIds);
  if (teamIds === null) {
    throw new AppError({
      code: 403,
      message: "You can only include teams you belong to",
      context: { userId: auth.userId, teamIds: data.teamIds },
    });
  }

  const config = await services.calendarSync.createCalendarSync(
    {
      id: generateRandomUUID(),
      userId: auth.userId,
      name: data.name,
      scope: data.scope,
      distinguishMine: data.distinguishMine,
      token: services.calendarSync.generateFeedToken(),
    },
    teamIds,
    data.types.map((t) => ({
      vacationType: t.type,
      color: t.color,
      mineColor: t.mineColor ?? null,
    }))
  );

  return res.status(201).json(serializeConfig(config, feedBaseUrl(req), true));
};
