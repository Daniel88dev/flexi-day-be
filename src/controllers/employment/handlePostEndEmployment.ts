import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import {
  markCalendarTargetsDirty,
  markMemberGroupEventTargetsDirty,
} from "../../services/calendarSync/markCalendarTargetsDirty.js";
import { endEmployment } from "../../services/employment/endEmploymentServices.js";
import type { ValidatedEndEmploymentType } from "../../services/employment/types.js";
import { presentEmployment } from "./utils.js";

export const handlePostEndEmployment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const employmentId = z.uuid().parse(req.params.employmentId);
  const { endedOn } = req.body as ValidatedEndEmploymentType;

  const { employment, cancelled } = await db.transaction((tx) =>
    endEmployment({ employmentId, endedOn, actorUserId: auth.userId }, tx)
  );

  await markCalendarTargetsDirty(cancelled);
  await markMemberGroupEventTargetsDirty(employment.userId);

  return res
    .status(200)
    .json({ ...presentEmployment(employment), cancelledBookings: cancelled.length });
};
