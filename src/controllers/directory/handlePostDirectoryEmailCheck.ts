import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { checkDirectoryEmail } from "../../services/directory/directoryPersonServices.js";
import type { DirectoryEmailCheck } from "../../services/directory/types.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePostDirectoryEmailCheck = async (req: Request, res: Response) => {
  const { email } = req.body as DirectoryEmailCheck;
  const result = await db.transaction(async (tx) =>
    checkDirectoryEmail(await directoryViewerFor(req, tx), email, tx)
  );
  return res.status(200).json(result);
};
