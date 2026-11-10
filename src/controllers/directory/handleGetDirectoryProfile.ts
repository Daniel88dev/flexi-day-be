import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { readDirectoryProfile } from "../../services/directory/directoryLookups.js";
import { requirePathParam } from "../pathParams.js";
import { requestedLanguage } from "./directoryViewerFor.js";

export const handleGetDirectoryProfile = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const profile = await readDirectoryProfile({
    auth: getAuth(req),
    organizationId: requirePathParam(req.params.organizationId, "organization id"),
    employmentId,
    language: requestedLanguage(req),
  });
  return res.status(200).json(profile);
};
