import { z } from "zod";

export type GroupMirror = {
  id: string;
  userId: string;
  sourceGroupId: string;
  targetGroupId: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A mirror plus the source group's name, for the settings screen. */
export type GroupMirrorListItem = GroupMirror & {
  sourceGroupName: string;
};

/**
 * One of the caller's other groups, and whether its records are currently
 * mirrored into the group being configured.
 */
export type MirrorCandidate = {
  groupId: string;
  groupName: string;
  mirrored: boolean;
};

export const validatePutGroupMirrors = z.object({
  sourceGroupIds: z
    .array(z.uuid())
    .max(50)
    .transform((ids) => Array.from(new Set(ids))),
});

export type ValidatedPutGroupMirrorsType = z.infer<typeof validatePutGroupMirrors>;
