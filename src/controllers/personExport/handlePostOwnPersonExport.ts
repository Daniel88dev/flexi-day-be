import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { readLogAudience } from "../../db/schema/read-log-schema.js";
import { getAuth } from "../../middleware/authSession.js";
import {
  assertExportStoreConfigured,
  hasEmployment,
  presentPersonExport,
  requestPersonExport,
} from "../../services/personExport/personExportServices.js";
import { enqueuePersonExport } from "../../services/personExport/personExportQueue.js";
import type { ValidatedOwnPersonExportRequest } from "../../services/personExport/types.js";
import AppError from "../../utils/appError.js";

export const handlePostOwnPersonExport = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { organizationId } = req.body as ValidatedOwnPersonExportRequest;
  assertExportStoreConfigured();

  const { row, created } = await db.transaction(async (tx) => {
    if (!(await hasEmployment(organizationId, auth.userId, tx))) {
      throw new AppError({
        code: 403,
        message: "Your account is not bound to an employment in that organization",
        logging: true,
        context: { userId: auth.userId, organizationId },
        publicContext: { code: "NOT_EMPLOYED" },
      });
    }
    return requestPersonExport(
      {
        organizationId,
        subjectUserId: auth.userId,
        requestedByUserId: auth.userId,
        audience: readLogAudience.Self,
      },
      tx
    );
  });

  if (created) enqueuePersonExport(row.id);
  return res.status(202).json(presentPersonExport(row));
};
