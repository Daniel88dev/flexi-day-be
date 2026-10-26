import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { refuse } from "../../utils/appError.js";
import { showSensitiveSection } from "../../services/directory/showSectionServices.js";
import type { SensitiveSectionName } from "../../services/directory/types.js";
import { requirePathParam } from "../attendance/utils.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

const SECTIONS = new Set<string>(["contact", "personal"]);

export const handlePostShowSection = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const section = requirePathParam(req.params.section, "section");
  if (!SECTIONS.has(section)) {
    throw refuse(404, "SECTION_NOT_FOUND", "Only Contact and Personal open with Show", { section });
  }

  const shown = await db.transaction(async (tx) => {
    const viewer = await directoryViewerFor(req, tx);
    return showSensitiveSection(viewer, employmentId, section as SensitiveSectionName, tx);
  });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(shown);
};
