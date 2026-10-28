import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import AppError, { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { generateInviteCode } from "../../utils/inviteCode.js";
import { generateInviteLinkSecret, hashInviteLinkSecret } from "../../utils/inviteLinkSecret.js";
import {
  assertCanAddMember,
  assertDirectoryWritable,
  assertGroupWritable,
} from "../billing/guards.js";
import { getGroup } from "../group/groupServices.js";
import { inviteExpiryFrom } from "../groupUser/inviteNotifier.js";
import {
  createInviteLink,
  inviteStatus,
  revokeOpenInviteForEmail,
} from "../groupUser/inviteLinkServices.js";
import { getOrganizationById, lockOrganization } from "../organization/organizationServices.js";
import { lockRecordInReach, type DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryInviteView, PostDirectoryInvite } from "./types.js";

/** The audience whose Send directory invite cell credits the viewer, on an open record without an account. */
export const sendInviteGrantor = (viewer: DirectoryViewer) =>
  viewer.accessTo({ userId: null, ended: false }).actGrantedBy[
    directoryPermissionRow.SendDirectoryInvite
  ];

/** Revokes the open directory invite of an Employment, if any, so its code and link stop working. */
export const revokeOpenEmploymentInvite = async (employmentId: string, tx: DbTransaction) => {
  await tx
    .update(inviteLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(inviteLink.employmentId, employmentId),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt)
      )
    );
};

export type SentDirectoryInvite = {
  invite: DirectoryInviteView;
  linkSecret: string;
  organizationName: string;
  personName: string;
};

/**
 * Send directory invite: an invite bound to the person's address that claims
 * their account-less Employment, optionally joining a group too. Re-sending
 * revokes the open one first. Needs the act cell and the directory plan.
 */
export const sendDirectoryInvite = async (
  viewer: DirectoryViewer,
  employmentId: string,
  input: PostDirectoryInvite,
  tx: DbTransaction
): Promise<SentDirectoryInvite> => {
  const { organizationId } = viewer;
  await lockOrganization(organizationId, tx);
  const { record, context } = await lockRecordInReach(viewer, employmentId, tx);
  if (sendInviteGrantor(viewer) === null) {
    throw refuse(403, "INVITE_DENIED", "You can't send directory invites", context);
  }
  if (record.endedAt !== null) {
    throw refuse(409, "EMPLOYMENT_ENDED", "This person no longer works here", context);
  }
  if (record.userId !== null) {
    throw refuse(422, "HAS_ACCOUNT", "This person already has an account", context);
  }
  await assertDirectoryWritable(organizationId, tx);
  if (!record.email) {
    throw refuse(422, "NO_EMAIL", "Add the person's email before inviting them", context);
  }
  const email = record.email.toLowerCase();

  const groupId = input.groupId ?? null;
  if (groupId !== null) {
    const group = await getGroup(groupId, tx);
    if (!group || group.organizationId !== organizationId) {
      throw refuse(422, "GROUP_NOT_FOUND", "No such group in this organization", {
        ...context,
        groupId,
      });
    }
    await assertGroupWritable(groupId, tx);
    await revokeOpenInviteForEmail(groupId, email, tx);
  }
  await revokeOpenEmploymentInvite(employmentId, tx);
  if (groupId !== null) await assertCanAddMember(groupId, tx);

  const linkSecret = generateInviteLinkSecret();
  const created = await createInviteLink(
    {
      id: generateRandomUUID(),
      groupId,
      employmentId,
      code: generateInviteCode(),
      email,
      linkSecretHash: hashInviteLinkSecret(linkSecret),
      invitedByUserId: viewer.standing.userId,
      expiresAt: inviteExpiryFrom(new Date()),
    },
    tx
  );
  if (!created) {
    throw new AppError({
      code: 500,
      message: "Failed to create the invite",
      logging: true,
      context,
    });
  }

  const organization = await getOrganizationById(organizationId, tx);
  return {
    invite: {
      id: created.id,
      employmentId,
      groupId,
      email,
      status: inviteStatus(created),
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    },
    linkSecret,
    organizationName: organization?.name ?? "",
    personName: record.name ?? email,
  };
};
