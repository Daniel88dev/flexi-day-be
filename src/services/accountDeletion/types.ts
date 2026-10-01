import { z } from "zod";

export type DeletionBlocker =
  | { kind: "GROUP_HAS_MEMBERS"; groupId: string; groupName: string; otherMembers: number }
  | {
      kind: "ORGANIZATION_HAS_MEMBERS";
      organizationId: string;
      organizationName: string;
      otherMembers: number;
    }
  | { kind: "SUBSCRIPTION_RENEWING"; organizationId: string; organizationName: string }
  | { kind: "SUPPORT_ADMIN" };

export type DeletionConfirmation = "password" | "recent-sign-in";

export type DeletionStatus = {
  canDelete: boolean;
  blockers: DeletionBlocker[];
  confirmation: DeletionConfirmation;
};

export enum DeletionRefusal {
  PasswordInvalid = "PASSWORD_INVALID",
  ReauthRequired = "REAUTH_REQUIRED",
  DeletionBlocked = "DELETION_BLOCKED",
}

/** better-auth's default `session.freshAge`, which this config leaves unset. */
export const FRESH_SIGN_IN_MS = 24 * 60 * 60 * 1000;

export const validatePostDeleteMe = z.object({ password: z.string().optional() }).default({});

export type PostDeleteMeBody = z.infer<typeof validatePostDeleteMe>;
