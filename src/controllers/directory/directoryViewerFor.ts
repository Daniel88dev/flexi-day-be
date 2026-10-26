import type { Request } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { loadDirectoryViewer } from "../../services/directory/directoryViewer.js";
import { requirePathParam } from "../attendance/utils.js";

export const directoryViewerFor = (req: Request) =>
  loadDirectoryViewer(
    getAuth(req).userId,
    requirePathParam(req.params.organizationId, "organization id")
  );
