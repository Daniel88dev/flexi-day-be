import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { createDirectoryPerson } from "../../services/directory/directoryPersonServices.js";
import type { PostDirectoryPerson } from "../../services/directory/types.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePostDirectoryPerson = async (req: Request, res: Response) => {
  const profile = await db.transaction(async (tx) =>
    createDirectoryPerson(await directoryViewerFor(req, tx), req.body as PostDirectoryPerson, tx)
  );
  return res.status(201).json(profile);
};
