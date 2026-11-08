import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { readFormerDirectoryPeople } from "../../services/directory/directoryLookups.js";
import { requirePathParam } from "../pathParams.js";
import { requestedLanguage } from "./directoryViewerFor.js";

export const handleGetFormerDirectoryPeople = async (req: Request, res: Response) => {
  const people = await readFormerDirectoryPeople({
    auth: getAuth(req),
    organizationId: requirePathParam(req.params.organizationId, "organization id"),
    language: requestedLanguage(req),
  });
  return res.status(200).json(people);
};
