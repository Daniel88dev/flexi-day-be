import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { getAuth } from "../../middleware/authSession.js";
import { sendDirectoryInvite } from "../../services/directory/directoryInviteServices.js";
import type { PostDirectoryInvite } from "../../services/directory/types.js";
import { notifyDirectoryInvited } from "../../services/groupUser/inviteNotifier.js";
import { requirePathParam } from "../pathParams.js";
import { directoryViewerFor } from "./directoryViewerFor.js";

export const handlePostDirectoryInvite = async (req: Request, res: Response) => {
  const employmentId = requirePathParam(req.params.employmentId, "employment id");
  const sent = await db.transaction(async (tx) =>
    sendDirectoryInvite(
      await directoryViewerFor(req, tx),
      employmentId,
      req.body as PostDirectoryInvite,
      tx
    )
  );

  const emailDelivered = await notifyDirectoryInvited({
    email: sent.invite.email,
    organizationName: sent.organizationName,
    inviterName: getAuth(req).userName,
    personName: sent.personName,
    linkSecret: sent.linkSecret,
  });

  return res.status(201).json({ invite: sent.invite, emailDelivered });
};
