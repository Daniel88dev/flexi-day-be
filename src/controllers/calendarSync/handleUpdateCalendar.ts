import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";
import { validateUpdateCalendarSync } from "../../services/calendarSync/types.js";
import { feedBaseUrl, resolveTeamIds, serializeConfig } from "./utils.js";

const services = createDBServices();

const validateUUID = z.uuid();

/** Replaces a config's settings, teams and types. */
export const handleUpdateCalendar = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const id = validateUUID.parse(req.params.id);
  const data = validateUpdateCalendarSync.parse(req.body);

  const userGroups = await services.groupUser.getAllGroupsForUser(auth.userId);
  const userGroupIds = new Set(userGroups.map((g) => g.groupId));

  const teamIds = resolveTeamIds(data, userGroupIds);
  if (teamIds === null) {
    throw new AppError({
      code: 403,
      message: "You can only include teams you belong to",
      context: { auth, teamIds: data.teamIds },
    });
  }

  const config = await services.calendarSync.updateCalendarSync(
    id,
    auth.userId,
    {
      name: data.name,
      scope: data.scope,
      distinguishMine: data.distinguishMine,
    },
    teamIds,
    data.types.map((t) => ({
      vacationType: t.type,
      color: t.color,
      mineColor: t.mineColor ?? null,
    }))
  );

  if (!config) {
    throw new AppError({
      code: 404,
      message: "Calendar not found",
      context: { auth, id },
    });
  }

  return res.status(200).json(serializeConfig(config, feedBaseUrl(req), true));
};
