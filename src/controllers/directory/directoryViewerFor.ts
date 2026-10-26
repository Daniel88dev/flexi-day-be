import type { Request } from "express";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import type { DbTransaction } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { loadDirectoryViewer } from "../../services/directory/directoryViewer.js";
import { requirePathParam } from "../attendance/utils.js";

const LANGUAGES = new Set<string>(Object.values(appLanguage));

/** `?language=en|cs`, the phone's device language or the web's interface language. */
export const requestedLanguage = (req: Request): appLanguage | undefined => {
  const value = req.query.language;
  return typeof value === "string" && LANGUAGES.has(value) ? (value as appLanguage) : undefined;
};

export const directoryViewerFor = (req: Request, tx?: DbTransaction) =>
  loadDirectoryViewer(
    getAuth(req).userId,
    requirePathParam(req.params.organizationId, "organization id"),
    tx,
    { language: requestedLanguage(req) }
  );
