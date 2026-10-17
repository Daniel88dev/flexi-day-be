import AppError from "../../utils/appError.js";
import type { DateString } from "../../utils/dateFunc.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { canViewWholeGroup } from "../report/reportScope.js";
import { getScopeEntries } from "../report/reportServices.js";
import { getUsersByIds } from "../user/userServices.js";
import { birthdayOccurrence } from "./birthdayOccurrence.js";
import { getBirthday } from "./birthdayServices.js";
import { liveBirthday, visibleBirthdays } from "./birthdayVisibility.js";
import type { Birthday, BirthdayCalendarRow } from "./types.js";

const birthdaysInScope = async (
  viewerId: string,
  groupId: string | undefined
): Promise<Birthday[]> => {
  if (groupId === undefined) {
    const own = liveBirthday(await getBirthday(viewerId));
    return own ? [own] : [];
  }

  if (!canViewWholeGroup(await getScopeEntries(viewerId), groupId)) {
    throw new AppError({
      code: 403,
      message: "No access to view this group's records",
      logging: true,
      context: { userId: viewerId, groupId },
    });
  }
  return visibleBirthdays(viewerId, groupId);
};

/**
 * The birthdays the calendar draws in a half-open window: without `groupId`
 * the caller's own (Mine scope), with it the group's visible birthdays plus the
 * caller's own. Ordered by date, then name.
 */
export const listBirthdaysInWindow = async (
  viewerId: string,
  groupId: string | undefined,
  range: { startDate: DateString; endDate: DateString }
): Promise<BirthdayCalendarRow[]> => {
  const dated = (await birthdaysInScope(viewerId, groupId)).flatMap((birthday) => {
    const occurrence = birthdayOccurrence(birthday, range);
    return occurrence ? [{ birthday, occurrence }] : [];
  });
  if (dated.length === 0) return [];

  const names = new Map(
    (await getUsersByIds(dated.map(({ birthday }) => birthday.userId))).map((row) => [
      row.id,
      row.name,
    ])
  );

  return dated
    .map(({ birthday, occurrence }) => ({
      userId: birthday.userId,
      user: buildUserSummary({ id: birthday.userId, name: names.get(birthday.userId) ?? "" }),
      date: occurrence.date,
      month: birthday.month,
      day: birthday.day,
      year: birthday.year,
      age: occurrence.age,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.user.name.localeCompare(b.user.name));
};
