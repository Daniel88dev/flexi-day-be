import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { contentDisposition } from "../../services/attachment/contentDisposition.js";
import {
  accountExportFilename,
  buildAccountExport,
} from "../../services/accountExport/accountExportServices.js";

export const handleGetMyAccountExport = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const now = new Date();

  const accountExport = await buildAccountExport(auth.userId, auth.sessionId, now);
  const body = JSON.stringify(accountExport, null, 2);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    contentDisposition("attachment", accountExportFilename(now))
  );
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).send(body);
};
