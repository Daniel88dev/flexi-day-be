import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import {
  assertExportStoreConfigured,
  presentPersonExport,
  requestEmploymentExport,
} from "../../services/personExport/personExportServices.js";
import { enqueuePersonExport } from "../../services/personExport/personExportQueue.js";

export const handlePostEmploymentExport = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const employmentId = z.uuid().parse(req.params.employmentId);
  assertExportStoreConfigured();

  const { row, created } = await db.transaction((tx) =>
    requestEmploymentExport({ employmentId, requestedByUserId: auth.userId }, tx)
  );

  if (created) enqueuePersonExport(row.id);
  return res.status(202).json(presentPersonExport(row));
};
