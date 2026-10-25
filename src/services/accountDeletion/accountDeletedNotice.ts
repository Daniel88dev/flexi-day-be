import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { notificationType } from "../../db/schema/notification-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { logger } from "../../middleware/logger.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createNotification } from "../notification/notificationServices.js";
import { getPersonContact } from "../person/personName.js";
import { pushNotifications } from "../push/pushServices.js";
import type { HandedOverGroup } from "./accountDeletionServices.js";

export type AccountDeletedNotice = { userId: string; title: string; body: string; href: string };

type OpenEmployment = { employmentId: string; organizationId: string; organizationName: string };
type MemberGroup = { groupId: string; groupName: string; organizationId: string };

type Audience = { adminOf: OpenEmployment[]; managerOf: MemberGroup[] };

const joinNames = (names: string[], and: string): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1] ?? ""}`;

const COPY = {
  [appLanguage.English]: {
    title: (name: string) => `${name} deleted their account`,
    stillOpen: (organizations: string[]) =>
      organizations.length === 1
        ? `Their employment in ${joinNames(organizations, "and")} is still open.`
        : `Their employments in ${joinNames(organizations, "and")} are still open.`,
    nowManage: (groupNames: string[]) => `You now manage ${joinNames(groupNames, "and")}.`,
  },
  [appLanguage.Czech]: {
    title: (name: string) => `${name} smazal(a) svůj účet`,
    stillOpen: (organizations: string[]) =>
      organizations.length === 1
        ? `Pracovní poměr v organizaci ${joinNames(organizations, "a")} zůstává otevřený.`
        : `Pracovní poměry v organizacích ${joinNames(organizations, "a")} zůstávají otevřené.`,
    nowManage: (groupNames: string[]) =>
      groupNames.length === 1
        ? `Nyní spravuješ skupinu ${joinNames(groupNames, "a")}.`
        : `Nyní spravuješ skupiny ${joinNames(groupNames, "a")}.`,
  },
};

/** Every title an `account_deleted` notice about `name` can carry, one per language. */
export const accountDeletedTitles = (name: string): string[] =>
  Object.values(COPY).map((copy) => copy.title(name));

const peopleCardHref = (employment: OpenEmployment) =>
  `/organization/?organizationId=${encodeURIComponent(employment.organizationId)}&employmentId=${encodeURIComponent(employment.employmentId)}`;

const memberListHref = (group: MemberGroup) =>
  `/groups/detail/?groupId=${encodeURIComponent(group.groupId)}&tab=members`;

/**
 * Who hears that `userId` deleted their account, and what each reads. Runs
 * inside the deletion's transaction, after `deleteAccountRows`, so it sees the
 * Employments still open and the groups already handed over; the notices go
 * out after the commit through `sendAccountDeletedNotices`.
 *
 * In each organization where the person has an open Employment: the owner,
 * every org admin, and the manager of each live group the person is in. One
 * notice per recipient, however many organizations and groups they share.
 */
export const planAccountDeletedNotices = async (
  userId: string,
  handedOverGroups: HandedOverGroup[],
  tx: DbTransaction
): Promise<AccountDeletedNotice[]> => {
  const open = await tx
    .select({
      employmentId: employments.id,
      organizationId: employments.organizationId,
      organizationName: organizations.name,
      ownerUserId: organizations.ownerUserId,
    })
    .from(employments)
    .innerJoin(organizations, eq(organizations.id, employments.organizationId))
    .where(and(eq(employments.userId, userId), isNull(employments.endedAt)))
    .orderBy(asc(organizations.name), asc(organizations.id));
  if (open.length === 0) return [];

  const organizationIds = open.map((row) => row.organizationId);
  const admins = await tx
    .select({ userId: organizationUsers.userId, organizationId: organizationUsers.organizationId })
    .from(organizationUsers)
    .where(
      and(
        inArray(organizationUsers.organizationId, organizationIds),
        isNull(organizationUsers.deletedAt)
      )
    );
  const memberGroups = await tx
    .select({
      groupId: groups.id,
      groupName: groups.groupName,
      organizationId: groups.organizationId,
      managerUserId: groups.managerUserId,
    })
    .from(groupUsers)
    .innerJoin(groups, eq(groups.id, groupUsers.groupId))
    .where(
      and(
        eq(groupUsers.userId, userId),
        isNull(groupUsers.deletedAt),
        isNull(groups.deletedAt),
        inArray(groups.organizationId, organizationIds)
      )
    )
    .orderBy(asc(groups.groupName), asc(groups.id));

  const audience = new Map<string, Audience>();
  const entryOf = (recipientId: string): Audience => {
    let entry = audience.get(recipientId);
    if (!entry) {
      entry = { adminOf: [], managerOf: [] };
      audience.set(recipientId, entry);
    }
    return entry;
  };
  for (const employment of open) {
    const adminIds = [
      employment.ownerUserId,
      ...admins
        .filter((admin) => admin.organizationId === employment.organizationId)
        .map((admin) => admin.userId),
    ];
    for (const adminId of new Set(adminIds)) {
      if (adminId !== userId) entryOf(adminId).adminOf.push(employment);
    }
  }
  for (const group of memberGroups) {
    if (group.managerUserId !== userId) entryOf(group.managerUserId).managerOf.push(group);
  }
  if (audience.size === 0) return [];

  const languages = new Map(
    (
      await tx
        .select({ userId: userSettings.userId, language: userSettings.language })
        .from(userSettings)
        .where(inArray(userSettings.userId, [...audience.keys()]))
    ).map((row) => [row.userId, row.language])
  );

  const nameIn = new Map<string, string>();
  const personNameIn = async (organizationId: string) => {
    const known = nameIn.get(organizationId);
    if (known !== undefined) return known;
    const name = (await getPersonContact(userId, { organizationId }, tx))?.name ?? "";
    nameIn.set(organizationId, name);
    return name;
  };

  const organizationName = new Map(open.map((row) => [row.organizationId, row.organizationName]));
  const notices: AccountDeletedNotice[] = [];
  for (const [recipientId, { adminOf, managerOf }] of audience) {
    const copy = COPY[languages.get(recipientId) ?? appLanguage.English];
    const linkedEmployment = adminOf[0];
    const linkedGroup = managerOf[0];
    const linkOrganizationId = linkedEmployment?.organizationId ?? linkedGroup?.organizationId;
    if (!linkOrganizationId) continue;

    const shared = organizationIds.filter(
      (id) =>
        adminOf.some((row) => row.organizationId === id) ||
        managerOf.some((row) => row.organizationId === id)
    );
    const handedOver = handedOverGroups
      .filter((group) => group.ownerUserId === recipientId)
      .map((group) => group.groupName);

    notices.push({
      userId: recipientId,
      title: copy.title(await personNameIn(linkOrganizationId)),
      body: [
        copy.stillOpen(shared.map((id) => organizationName.get(id) ?? "")),
        ...(handedOver.length > 0 ? [copy.nowManage(handedOver)] : []),
      ].join(" "),
      href: linkedEmployment ? peopleCardHref(linkedEmployment) : memberListHref(linkedGroup!),
    });
  }
  return notices;
};

/** In-app and pushed, never mailed. Runs after the commit and never throws. */
export const sendAccountDeletedNotices = async (
  deletedUserId: string,
  notices: AccountDeletedNotice[]
): Promise<void> => {
  try {
    const created = await Promise.all(
      notices.map((notice) =>
        createNotification({
          id: generateRandomUUID(),
          type: notificationType.AccountDeleted,
          ...notice,
        })
      )
    );
    await pushNotifications(
      created.filter((row) => row !== undefined),
      { passive: true }
    );
  } catch (error) {
    logger.error("Could not send the account deleted notices", { deletedUserId, err: error });
  }
};
