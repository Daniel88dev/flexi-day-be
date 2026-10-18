import AppError from "../../utils/appError.js";
import { resolveEntitlements, type Entitlements } from "../billing/entitlements.js";
import { getSubscriptionsForOrganizations } from "../billing/subscriptionServices.js";
import { getAllGroups } from "../group/groupServices.js";
import { getScopeEntries } from "../report/reportServices.js";
import { getBirthday, getMemberBirthdaysInGroups } from "./birthdayServices.js";
import {
  BIRTHDAY_SHARE_PLAN_REQUIRED,
  type Birthday,
  type BirthdayRecord,
  type BirthdaySettings,
  type ShareGroup,
} from "./types.js";

type GroupPlan = { groupId: string; groupName: string; entitlements: Entitlements };

/** Live groups with their organization's resolved plan, in `getAllGroups` order. */
const resolveGroupPlans = async (groupIds: string[]): Promise<GroupPlan[]> => {
  const groups = await getAllGroups(groupIds);
  const organizationIds = [...new Set(groups.map((group) => group.organizationId))];
  const subscriptions = await getSubscriptionsForOrganizations(organizationIds);
  const byOrganization = new Map(subscriptions.map((sub) => [sub.organizationId, sub]));
  const now = new Date();
  return groups.map((group) => ({
    groupId: group.id,
    groupName: group.groupName,
    entitlements: resolveEntitlements(byOrganization.get(group.organizationId) ?? null, now),
  }));
};

const isPaid = (entitlements: Entitlements) => entitlements.plan !== "FREE";

/** Never `writable`: that means over-limit groups lock, not that the organization paid. */
const isPaidOrLapsed = (entitlements: Entitlements) => isPaid(entitlements) || entitlements.lapsed;

export const liveBirthday = (row: BirthdayRecord | null): Birthday | null => {
  if (!row || row.deletedAt || row.month === null || row.day === null) return null;
  const { deletedAt: _deletedAt, ...rest } = row;
  return { ...rest, month: row.month, day: row.day };
};

const memberGroupPlans = async (userId: string): Promise<GroupPlan[]> => {
  const memberships = await getScopeEntries(userId);
  return resolveGroupPlans(memberships.map((entry) => entry.groupId));
};

/** The share switch may turn on while any of the user's live groups is on a paid plan. */
export const canShareBirthday = async (userId: string): Promise<boolean> =>
  (await memberGroupPlans(userId)).some((group) => isPaid(group.entitlements));

/** The groups a shared birthday reaches today: the user's paid and lapsed ones. */
export const getShareGroups = async (userId: string): Promise<ShareGroup[]> =>
  (await memberGroupPlans(userId))
    .filter((group) => isPaidOrLapsed(group.entitlements))
    .map(({ groupId, groupName }) => ({ groupId, groupName }));

/** What the settings card reads: the user's birthday, whether sharing may turn on, and its reach. */
export const getBirthdaySettings = async (userId: string): Promise<BirthdaySettings> => {
  const [row, groups] = await Promise.all([getBirthday(userId), memberGroupPlans(userId)]);
  const birthday = liveBirthday(row);
  return {
    birthday: birthday
      ? { month: birthday.month, day: birthday.day, year: birthday.year, shared: birthday.shared }
      : null,
    canShare: groups.some((group) => isPaid(group.entitlements)),
    shareGroups: groups
      .filter((group) => isPaidOrLapsed(group.entitlements))
      .map(({ groupId, groupName }) => ({ groupId, groupName })),
  };
};

export const assertCanShareBirthday = async (userId: string): Promise<void> => {
  if (await canShareBirthday(userId)) return;
  throw new AppError({
    code: 402,
    message: "Sharing a birthday requires a group on a paid plan",
    logging: true,
    context: { userId },
    publicContext: { reason: "PLAN_LIMIT", code: BIRTHDAY_SHARE_PLAN_REQUIRED },
  });
};

/** The live groups among these whose members' shared birthdays show: paid or lapsed. */
export const birthdayGroupIds = async (groupIds: string[]): Promise<string[]> =>
  (await resolveGroupPlans(groupIds))
    .filter((group) => isPaidOrLapsed(group.entitlements))
    .map((group) => group.groupId);

/**
 * The viewer's own birthday plus the shared birthdays of live members of every
 * group the viewer sees in full, where that group's organization is paid or
 * lapsed. `groupId` narrows the groups to one. Each user appears once.
 */
export const visibleBirthdays = async (viewerId: string, groupId?: string): Promise<Birthday[]> => {
  const scope = await getScopeEntries(viewerId);
  const viewable = scope
    .filter((entry) => entry.access === "all" && (!groupId || entry.groupId === groupId))
    .map((entry) => entry.groupId);

  const [own, members] = await Promise.all([
    getBirthday(viewerId),
    birthdayGroupIds(viewable).then((ids) => getMemberBirthdaysInGroups(ids)),
  ]);

  const result: Birthday[] = [];
  const ownBirthday = liveBirthday(own);
  if (ownBirthday) result.push(ownBirthday);
  const seen = new Set([viewerId]);
  for (const row of members) {
    const birthday = liveBirthday(row);
    if (!birthday || !birthday.shared || seen.has(birthday.userId)) continue;
    seen.add(birthday.userId);
    result.push(birthday);
  }
  return result;
};

/**
 * The shared birthdays of live members of those `groupIds` the viewer sees in
 * full and whose organization is paid or lapsed, each user once, the viewer's
 * own included only when shared. What a team feed carries.
 */
export const sharedBirthdaysInGroups = async (
  viewerId: string,
  groupIds: string[]
): Promise<Birthday[]> => {
  const wanted = new Set(groupIds);
  const viewable = (await getScopeEntries(viewerId))
    .filter((entry) => entry.access === "all" && wanted.has(entry.groupId))
    .map((entry) => entry.groupId);
  const members = await getMemberBirthdaysInGroups(await birthdayGroupIds(viewable));
  return members.map(liveBirthday).filter((row): row is Birthday => row !== null && row.shared);
};
