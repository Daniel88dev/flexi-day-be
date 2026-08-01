import { z } from "zod";
import type { UserSummary } from "../../utils/userPresentation.js";

export type GroupUser = {
  id: string;
  groupId: string;
  userId: string;
  viewAccess: boolean;
  adminAccess: boolean;
  controlledUser: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupUserInsertType = {
  id: string;
  groupId: string;
  userId: string;
  viewAccess?: boolean;
  adminAccess?: boolean;
  controlledUser?: boolean;
};

export type GroupUserPermissions = Pick<GroupUser, "viewAccess" | "adminAccess" | "controlledUser">;

/**
 * A membership row enriched with the member's identity. The members list is
 * useless without it — the raw row only carries a `userId`.
 */
export type GroupUserListItem = GroupUser & {
  user: UserSummary;
  email: string;
};

export type InviteLink = {
  id: string;
  groupId: string;
  code: string;
  /** Address the invite was issued to; null only on rows predating email invites. */
  email: string | null;
  invitedByUserId: string | null;
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type InviteLinkInsertType = {
  id: string;
  groupId: string;
  code: string;
  email?: string | null;
  invitedByUserId?: string | null;
  expiresAt: Date;
};

/** An invite plus who sent it, for the group's pending-invites list. */
export type InviteLinkListItem = InviteLink & {
  invitedByName: string | null;
};

export const validatePostGroupInvite = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
});

export type ValidatedPostGroupInviteType = z.infer<typeof validatePostGroupInvite>;

export const validatePutGroupUserUpdate = z.object({
  groupId: z.uuid(),
  data: z.array(
    z.object({
      // better-auth user ids are opaque non-UUID strings, so validate as a
      // non-empty string rather than z.uuid().
      userId: z.string().min(1),
      viewAccess: z.boolean(),
      adminAccess: z.boolean(),
      controlledUser: z.boolean(),
    })
  ),
});

export type ValidatedPutGroupUserUpdateType = z.infer<typeof validatePutGroupUserUpdate>;
