import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { logger } from "../../middleware/logger.js";
import {
  eraseEmployment,
  removeErasedObjects,
} from "../../services/employment/eraseEmploymentServices.js";
import type { ValidatedEraseEmploymentType } from "../../services/employment/types.js";

export const handlePostEraseEmployment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const employmentId = z.uuid().parse(req.params.employmentId);
  const { confirmName } = req.body as ValidatedEraseEmploymentType;

  const erased = await db.transaction((tx) =>
    eraseEmployment({ employmentId, confirmName, actorUserId: auth.userId }, tx)
  );

  await removeErasedObjects(erased);
  logger.info("organization data erased", {
    actorUserId: auth.userId,
    organizationId: erased.organizationId,
    userId: erased.userId,
    employments: erased.employmentIds.length,
    attachments: erased.attachments.length,
    exports: erased.exportKeys.length,
  });

  return res.status(204).end();
};
