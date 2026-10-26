import type { Request } from "express";
import { appLanguage } from "../../db/schema/user-settings-schema.js";
import type { DbTransaction } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import {
  loadDirectoryViewer,
  type DirectoryViewerOptions,
} from "../../services/directory/directoryViewer.js";
import { requirePathParam } from "../pathParams.js";

const LANGUAGES = new Set<string>(Object.values(appLanguage));

/** `?language=en|cs`, the phone's device language or the web's interface language. */
export const requestedLanguage = (req: Request): appLanguage | undefined => {
  const value = req.query.language;
  return typeof value === "string" && LANGUAGES.has(value) ? (value as appLanguage) : undefined;
};

export const directoryViewerFor = (
  req: Request,
  tx?: DbTransaction,
  options: Pick<DirectoryViewerOptions, "whileOff"> = {}
) =>
  loadDirectoryViewer(
    getAuth(req).userId,
    requirePathParam(req.params.organizationId, "organization id"),
    tx,
    { ...options, language: requestedLanguage(req) }
  );
