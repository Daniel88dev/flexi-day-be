import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { refuse } from "../../utils/appError.js";
import { showSensitiveSection } from "../../services/directory/showSectionServices.js";
import { isSensitiveSectionKey } from "../../services/directory/sectionKeys.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePostShowSection = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const section = requirePathParam(req.params.section, "section");
  if (!isSensitiveSectionKey(section)) {
    throw refuse(404, "SECTION_NOT_FOUND", "Only Contact and Personal open with Show", { section });
  }

  const shown = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return showSensitiveSection(viewer, employmentId, section, tx);
  });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(shown);
};
