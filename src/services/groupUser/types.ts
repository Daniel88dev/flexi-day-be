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
  usedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type InviteLinkInsertType = {
  id: string;
  groupId: string;
  code: string;
  expiresAt: Date;
};

export const validatePutGroupUserUpdate = z.object({
  groupId: z.uuid(),
  data: z.array(
    z.object({
      userId: z.uuid(),
      viewAccess: z.boolean(),
      adminAccess: z.boolean(),
      controlledUser: z.boolean(),
    })
  ),
});

export type ValidatedPutGroupUserUpdateType = z.infer<typeof validatePutGroupUserUpdate>;
