import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { showProfileSection } from "../../services/directory/directoryLookups.js";
import { requirePathParam } from "../pathParams.js";
import { requestedLanguage } from "./directoryViewerFor.js";

export const handlePostShowSection = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const section = requirePathParam(req.params.section, "section");

  const shown = await showProfileSection({
    auth: getAuth(req),
    organizationId: requirePathParam(req.params.organizationId, "organization id"),
    employmentId,
    section,
    language: requestedLanguage(req),
  });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(shown);
};
