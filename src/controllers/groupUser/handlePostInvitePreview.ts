import type { Request, Response } from "express";
import AppError from "../../utils/appError.js";
import { hashInviteLinkSecret } from "../../utils/inviteLinkSecret.js";
import { getInvitePreviewBySecretHash } from "../../services/groupUser/inviteLinkServices.js";
import type { ValidatedInviteLinkTokenType } from "../../services/groupUser/types.js";

/** Public: what the invite link's holder sees before joining. Consumes nothing. */
export const handlePostInvitePreview = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { token }: ValidatedInviteLinkTokenType = req.body;

  const preview = await getInvitePreviewBySecretHash(hashInviteLinkSecret(token));

  if (!preview) {
    throw new AppError({
      message: "Invite not found",
      logging: true,
      code: 404,
      context: { url: req.url },
      publicContext: { code: "INVITE_NOT_FOUND" },
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(preview);
};
