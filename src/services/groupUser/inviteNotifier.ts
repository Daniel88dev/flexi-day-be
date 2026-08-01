import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import { emailSender } from "../email/index.js";

/** Matches the invite's `expiresAt`; SES needs it as a human-readable string. */
export const INVITE_EXPIRES_IN = "14 days";
export const INVITE_TTL_DAYS = 14;

export const inviteExpiryFrom = (now: Date): Date =>
  new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

/** The plain sign-up page — deliberately carries no code or token. */
export const buildSignUpUrl = (): string => new URL("/sign-up/", config.email.appUrl).toString();

/** Where an account that already exists pastes the code. */
export const buildJoinUrl = (): string => new URL("/groups/", config.email.appUrl).toString();

/**
 * Sends the invite email. Returns whether it went out rather than throwing:
 * the invite row is already committed and the code is handed back to the
 * admin, so a mail failure should downgrade to "share this code yourself"
 * instead of failing a request that already did its work.
 */
export const notifyGroupInvited = async (input: {
  email: string;
  groupName: string;
  inviterName: string;
  code: string;
}): Promise<boolean> => {
  try {
    await emailSender.sendTemplated({
      to: input.email,
      template: "group-invite",
      data: {
        groupName: input.groupName,
        inviterName: input.inviterName,
        inviteCode: input.code,
        signUpUrl: buildSignUpUrl(),
        joinUrl: buildJoinUrl(),
        invitedEmail: input.email,
        expiresIn: INVITE_EXPIRES_IN,
      },
    });
    return true;
  } catch (error) {
    logger.error("Failed to send group invite email", {
      email: input.email,
      groupName: input.groupName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};
