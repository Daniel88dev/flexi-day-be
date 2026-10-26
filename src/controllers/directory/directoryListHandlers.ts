import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import {
  addDirectoryListEntry,
  deleteDirectoryListEntry,
  readDirectoryList,
  updateDirectoryListEntry,
} from "../../services/directory/directoryListServices.js";
import type {
  DirectoryListKind,
  PatchListEntry,
  PostListEntry,
} from "../../services/directory/types.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const directoryListHandlers = (kind: DirectoryListKind) => ({
  list: async (req: Request, res: Response) => {
    const viewer = await directoryViewerFor(req);
    return res.status(200).json(await readDirectoryList(viewer, kind));
  },
  add: async (req: Request, res: Response) => {
    const entry = await db.transaction(async (tx) =>
      addDirectoryListEntry(await directoryViewerFor(req, tx), kind, req.body as PostListEntry, tx)
    );
    return res.status(201).json(entry);
  },
  update: async (req: Request, res: Response) => {
    const entryId = requirePathParam(req.params.entryId, "entry id");
    const entry = await db.transaction(async (tx) =>
      updateDirectoryListEntry(
        await directoryViewerFor(req, tx),
        kind,
        entryId,
        req.body as PatchListEntry,
        tx
      )
    );
    return res.status(200).json(entry);
  },
  remove: async (req: Request, res: Response) => {
    const entryId = requirePathParam(req.params.entryId, "entry id");
    await db.transaction(async (tx) =>
      deleteDirectoryListEntry(await directoryViewerFor(req, tx), kind, entryId, tx)
    );
    return res.status(204).send();
  },
});
