import type { Request, Response } from "express";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { findUserByEmail } from "../../services/dev/devSeedServices.js";
import { mintSignInTicket } from "../../services/dev/signInTicketServices.js";

export const validatePostDevSignInTicket = z.object({
  email: z.email(),
});

export type ValidatedPostDevSignInTicketType = z.infer<typeof validatePostDevSignInTicket>;

/**
 * Mints a single-use ticket the phone app redeems at
 * `POST /api/auth/dev/redeem-sign-in-ticket` for a device-bound session.
 */
export const handlePostDevSignInTicket = async (req: Request, res: Response) => {
  const { email } = req.body as ValidatedPostDevSignInTicketType;

  const found = await findUserByEmail(email);
  if (!found) {
    throw new AppError({
      message: "No such user in the local database",
      code: 404,
      publicContext: { email },
    });
  }

  const { ticket, expiresAt } = mintSignInTicket(found.id);

  return res.status(200).json({
    user: { id: found.id, email: found.email, name: found.name },
    ticket,
    expiresAt: expiresAt.toISOString(),
  });
};
