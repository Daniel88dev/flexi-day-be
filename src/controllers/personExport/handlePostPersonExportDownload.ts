import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { signExportDownload } from "../../services/personExport/personExportServices.js";

export const handlePostPersonExportDownload = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const exportId = z.uuid().parse(req.params.exportId);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(await signExportDownload(exportId, auth.userId));
};
