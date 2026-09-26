import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { db } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";
import AppError from "../../utils/appError.js";
import { auth } from "../../utils/auth.js";
import { withoutConfirmationEmail } from "../../utils/confirmationEmail.js";
import { hashInviteLinkSecret } from "../../utils/inviteLinkSecret.js";
import { assertCanAddMember } from "../../services/billing/guards.js";
import { getInviteLinkBySecretHash } from "../../services/groupUser/inviteLinkServices.js";
import { assertOpenInviteFor, redeemInvite } from "../../services/groupUser/inviteRedemption.js";
import type { ValidatedInviteSignUpType } from "../../services/groupUser/types.js";
import { deleteUser, getUserByEmail, markEmailVerified } from "../../services/user/userServices.js";

const accountExists = (inviteId: string) =>
  new AppError({
    message: "User already exists. Use another email.",
    logging: true,
    code: 422,
    context: { inviteId },
    publicContext: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
  });

const betterAuthRefusal = async (response: globalThis.Response, inviteId: string) => {
  const payload = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  return new AppError({
    message: payload?.message ?? "Failed to sign up",
    logging: true,
    code: response.status,
    context: { inviteId },
    publicContext: payload?.code ? { code: payload.code } : undefined,
  });
};

/** Sign up with invite: see `docs/invariants.md`. */
export const handlePostInviteSignUp = async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { name, email, password, token }: ValidatedInviteSignUpType = req.body;
  const linkSecretHash = hashInviteLinkSecret(token);
  const logContext = { url: req.url };

  const invite = assertOpenInviteFor(
    await getInviteLinkBySecretHash(linkSecretHash),
    email,
    logContext
  );
  if (await getUserByEmail(email)) throw accountExists(invite.id);
  await assertCanAddMember(invite.groupId, undefined, { redeemingOpenInvite: true });

  const headers = fromNodeHeaders(req.headers);
  const signUp = await withoutConfirmationEmail(() =>
    auth.api.signUpEmail({ body: { name, email, password }, headers, asResponse: true })
  );
  if (!signUp.ok) throw await betterAuthRefusal(signUp, invite.id);

  // With `requireEmailVerification` on, better-auth answers an address that
  // already has an account with a made-up user instead of an error. A
  // concurrent sign-up that got there first shows up as an id that is not the
  // account's, and that account is not ours to roll back.
  const created = (await signUp.json().catch(() => null)) as { user?: { id?: string } } | null;
  const userId = created?.user?.id;
  if (!userId || (await getUserByEmail(email))?.id !== userId) throw accountExists(invite.id);

  let membership: Awaited<ReturnType<typeof redeemInvite>>;
  try {
    membership = await db.transaction(async (tx) => {
      const current = assertOpenInviteFor(
        await getInviteLinkBySecretHash(linkSecretHash, tx),
        email,
        logContext
      );
      const joined = await redeemInvite(current, userId, tx, logContext);
      await markEmailVerified(userId, tx);
      return joined;
    });
  } catch (error) {
    // Still unverified at this point, so if the delete fails too the leftover
    // is an ordinary unconfirmed sign-up, which a password reset settles.
    await deleteUser(userId).catch((cleanupError: unknown) => {
      logger.error("invite sign-up rollback failed", {
        userId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });
    throw error;
  }

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    headers,
    asResponse: true,
  });

  if (!signIn.ok) {
    logger.error("invite sign-up could not start a session", { userId, status: signIn.status });
    return res.status(201).json({ user: null, token: null, membership });
  }

  for (const cookie of signIn.headers.getSetCookie()) {
    res.append("Set-Cookie", cookie);
  }
  const session = (await signIn.json().catch(() => null)) as {
    user?: unknown;
    token?: string | null;
  } | null;

  logger.info("invite sign-up completed", { userId, groupId: membership.groupId });

  return res
    .status(201)
    .json({ user: session?.user ?? null, token: session?.token ?? null, membership });
};
