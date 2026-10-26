import type { Request, Response } from "express";
import AppError from "../../utils/appError.js";
import { listReadLog } from "../../services/directory/readLogServices.js";
import { validateReadLogQuery } from "../../services/directory/types.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handleGetReadLog = async (req: Request, res: Response) => {
  const query = validateReadLogQuery.safeParse(req.query);
  if (!query.success) {
    throw new AppError({ code: 422, message: "Invalid read log query", logging: false });
  }
  const viewer = await directoryViewerFor(req);
  return res.status(200).json(await listReadLog(viewer, query.data));
};
