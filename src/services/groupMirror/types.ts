import { z } from "zod";
import type { UserSummary } from "../../utils/userPresentation.js";

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
 * A group a member's records could be projected from, and whether they
 * currently are. `manageable` is false for a source the viewer does not
 * administer: shown for completeness, not theirs to change.
 */
export type MirrorCandidate = {
  groupId: string;
  groupName: string;
  mirrored: boolean;
  manageable: boolean;
};

/** One member of the group being configured, with their mirror sources. */
export type MirrorMember = {
  userId: string;
  user: UserSummary;
  email: string;
  candidates: MirrorCandidate[];
};

export const validatePutGroupMirrors = z.object({
  // better-auth user ids are opaque non-UUID strings.
  userId: z.string().min(1),
  sourceGroupIds: z
    .array(z.uuid())
    .max(50)
    .transform((ids) => Array.from(new Set(ids))),
});

export type ValidatedPutGroupMirrorsType = z.infer<typeof validatePutGroupMirrors>;
