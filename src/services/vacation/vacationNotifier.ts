import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import { emailSender } from "../email/index.js";
import type { TemplatedEmail } from "../email/index.js";
import { createDBServices } from "../DBServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { notificationType } from "../../db/schema/notification-schema.js";
import { vacationType } from "../../db/schema/vacation-schema.js";
import type { VacationType } from "./types.js";
import type { UserContact } from "../user/userServices.js";

const services = createDBServices();

/** SES renders a missing variable as an empty string, so blanks get a dash. */
const OR_DASH = "—";

const LEAVE_TYPE_LABELS: Record<vacationType, string> = {
  [vacationType.Vacation]: "Vacation",
  [vacationType.HomeOffice]: "Home office",
  [vacationType.Sick]: "Sick",
  [vacationType.BankHoliday]: "Bank holiday",
  [vacationType.NonPaidLeave]: "Non-paid leave",
  [vacationType.PaidTimeOff]: "Paid time off",
  [vacationType.SickLeave]: "Sick leave",
  [vacationType.StudyLeave]: "Study leave",
  [vacationType.Other]: "Other",
};

const formatDay = (isoDay: string): string =>
  new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** "12 Aug 2026" for a single day, "12 – 16 Aug 2026" for a span. */
export const formatDateRange = (isoDays: string[]): string => {
  const sorted = [...isoDays].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return OR_DASH;
  return first === last ? formatDay(first) : `${formatDay(first)} – ${formatDay(last)}`;
};

export const formatDayCount = (count: number): string =>
  `${count.toString()} ${count === 1 ? "day" : "days"}`;

/**
 * Deep link to the request. `/requests/` matches the frontend's static export
 * (trailing slash), and the id lets it open the detail dialog directly.
 */
export const buildRequestUrl = (vacationId: string): string => {
  const url = new URL("/requests/", config.email.appUrl);
  url.searchParams.set("vacationId", vacationId);
  return url.toString();
};

type VacationRow = Pick<
  VacationType,
  "id" | "userId" | "groupId" | "requestedDay" | "vacationType"
>;

type RowSummary = {
  rows: VacationRow[];
  dateRange: string;
  dayCount: string;
  leaveType: string;
  requestUrl: string;
};

const summarize = (rows: VacationRow[]): RowSummary | null => {
  const first = rows[0];
  if (!first) return null;
  return {
    rows,
    dateRange: formatDateRange(rows.map((r) => r.requestedDay)),
    dayCount: formatDayCount(rows.length),
    leaveType: LEAVE_TYPE_LABELS[first.vacationType],
    requestUrl: buildRequestUrl(first.id),
  };
};

const groupByUser = (rows: VacationRow[]): Map<string, VacationRow[]> => {
  const byUser = new Map<string, VacationRow[]>();
  for (const row of rows) {
    const existing = byUser.get(row.userId);
    if (existing) existing.push(row);
    else byUser.set(row.userId, [row]);
  }
  return byUser;
};

/**
 * Sends the workflow mails that the recipients still want, and records the
 * matching in-app notifications (which are not opt-out).
 *
 * Every failure is swallowed and logged: notifications run after the state
 * change has already committed, so a mail problem must never turn a
 * successful request into a 5xx the client would retry.
 */
type Delivery = {
  userId: string;
  email: TemplatedEmail;
  notification: {
    type: notificationType;
    title: string;
    body: string;
    href: string;
  };
};

const deliver = async (deliveries: Delivery[]): Promise<void> => {
  if (deliveries.length === 0) return;

  const acceptsEmail = await services.userSettings.filterUsersAcceptingEmail(
    deliveries.map((d) => d.userId)
  );

  await Promise.all(
    deliveries.map((delivery) =>
      services.notification.createNotification({
        id: generateRandomUUID(),
        userId: delivery.userId,
        ...delivery.notification,
      })
    )
  );

  await Promise.all(
    deliveries
      .filter((delivery) => acceptsEmail.has(delivery.userId))
      .map((delivery) => emailSender.sendTemplated(delivery.email))
  );
};

/**
 * Notifies the group's approvers that a new request needs a decision.
 * Called after the rows are committed.
 */
export const notifyVacationRequested = async (
  rows: VacationRow[],
  requester: { id: string; name: string },
  note: string | null
): Promise<void> => {
  try {
    const summary = summarize(rows);
    if (!summary) return;

    const group = await services.group.getApprovalUsers(rows[0]?.groupId ?? "");
    if (!group) return;

    const approvers = [
      {
        id: group.mainApprovalUserId,
        name: group.mainApprovalUserName,
        email: group.mainApprovalUserEmail,
      },
      {
        id: group.tempApprovalUserId,
        name: group.tempApprovalUserName,
        email: group.tempApprovalUserEmail,
      },
    ].filter(
      (a): a is { id: string; name: string; email: string } =>
        Boolean(a.id) && Boolean(a.name) && Boolean(a.email) && a.id !== requester.id
    );

    // De-duplicate: main and temp approver are often the same person.
    const unique = new Map(approvers.map((a) => [a.id, a]));
    if (unique.size === 0) return;

    await deliver(
      [...unique.values()].map((approver) => ({
        userId: approver.id,
        email: {
          to: approver.email,
          template: "vacation-approval-request",
          data: {
            approverName: approver.name,
            employeeName: requester.name,
            teamName: group.groupName,
            leaveType: summary.leaveType,
            dateRange: summary.dateRange,
            dayCount: summary.dayCount,
            note: note?.trim() ? note.trim() : OR_DASH,
            requestUrl: summary.requestUrl,
          },
        },
        notification: {
          type: notificationType.ApprovalRequested,
          title: `${requester.name} requested time off`,
          body: `${summary.leaveType} · ${summary.dateRange} (${summary.dayCount})`,
          href: summary.requestUrl,
        },
      }))
    );
  } catch (error) {
    logger.error("notifyVacationRequested failed", { error, requesterId: requester.id });
  }
};

/**
 * Notifies each affected employee that their request was approved or
 * rejected. A bulk decision can span several employees, so rows are grouped
 * per requester and each gets one mail covering their own days.
 */
export const notifyVacationDecision = async (
  rows: VacationRow[],
  decision: "approved" | "rejected",
  actor: { id: string; name: string },
  reason: string | null = null
): Promise<void> => {
  try {
    if (rows.length === 0) return;

    const byUser = groupByUser(rows);
    const group = await services.group.getApprovalUsers(rows[0]?.groupId ?? "");
    const employees = await services.user.getUsersByIds([...byUser.keys()]);
    const contacts = new Map(employees.map((e) => [e.id, e]));

    const deliveries: Delivery[] = [];

    for (const [userId, userRows] of byUser) {
      const employee = contacts.get(userId);
      const summary = summarize(userRows);
      if (!employee || !summary) continue;

      const shared = {
        employeeName: employee.name,
        approverName: actor.name,
        teamName: group?.groupName ?? "your team",
        leaveType: summary.leaveType,
        dateRange: summary.dateRange,
        dayCount: summary.dayCount,
        requestUrl: summary.requestUrl,
      };

      deliveries.push({
        userId,
        email:
          decision === "approved"
            ? { to: employee.email, template: "vacation-approved", data: shared }
            : {
                to: employee.email,
                template: "vacation-rejected",
                data: { ...shared, reason: reason?.trim() ? reason.trim() : OR_DASH },
              },
        notification: {
          type: notificationType.ApprovalDecided,
          title: decision === "approved" ? "Time off approved" : "Time off declined",
          body: `${summary.leaveType} · ${summary.dateRange} (${summary.dayCount})`,
          href: summary.requestUrl,
        },
      });
    }

    await deliver(deliveries);
  } catch (error) {
    logger.error("notifyVacationDecision failed", { error, decision, actorId: actor.id });
  }
};

/**
 * Notifies the "other side" that a comment was posted on a request. When an
 * approver (or admin) comments, the requester hears about it; when the
 * requester comments on their own request, the group's approvers do. The
 * commenter is never notified about their own comment.
 */
export const notifyVacationComment = async (
  row: VacationRow,
  actor: { id: string; name: string },
  message: string
): Promise<void> => {
  try {
    const trimmed = message.trim();
    if (!trimmed) return;

    const summary = summarize([row]);
    if (!summary) return;

    const group = await services.group.getApprovalUsers(row.groupId);
    if (!group) return;

    const employee = await services.user.getUserById(row.userId);
    if (!employee) return;

    const recipients: UserContact[] =
      actor.id === row.userId
        ? [
            {
              id: group.mainApprovalUserId,
              name: group.mainApprovalUserName,
              email: group.mainApprovalUserEmail,
            },
            {
              id: group.tempApprovalUserId,
              name: group.tempApprovalUserName,
              email: group.tempApprovalUserEmail,
            },
          ].filter(
            (a): a is UserContact =>
              Boolean(a.id) && Boolean(a.name) && Boolean(a.email) && a.id !== actor.id
          )
        : [employee].filter((e) => e.id !== actor.id);

    const unique = [...new Map(recipients.map((r) => [r.id, r])).values()];
    if (unique.length === 0) return;

    await deliver(
      unique.map((recipient) => ({
        userId: recipient.id,
        email: {
          to: recipient.email,
          template: "vacation-comment",
          data: {
            recipientName: recipient.name,
            employeeName: employee.name,
            commenterName: actor.name,
            teamName: group.groupName,
            leaveType: summary.leaveType,
            dateRange: summary.dateRange,
            message: trimmed,
            requestUrl: summary.requestUrl,
          },
        },
        notification: {
          type: notificationType.Comment,
          title: `${actor.name} commented on a request`,
          body: `${employee.name} · ${summary.leaveType} · ${summary.dateRange}`,
          href: summary.requestUrl,
        },
      }))
    );
  } catch (error) {
    logger.error("notifyVacationComment failed", { error, vacationId: row.id });
  }
};

/**
 * Notifies about a cancelled request that had already been approved. Pending
 * requests are dropped silently — nobody was counting on them yet.
 *
 * When someone else cancels, the employee hears about it; when the employee
 * cancels their own approved days, the approvers do.
 */
export const notifyVacationCancelled = async (
  row: VacationRow & { approvedAt: Date | null },
  actor: { id: string; name: string },
  reason: string | null
): Promise<void> => {
  try {
    if (!row.approvedAt) return;

    const summary = summarize([row]);
    if (!summary) return;

    const group = await services.group.getApprovalUsers(row.groupId);
    if (!group) return;

    const employee = await services.user.getUserById(row.userId);
    if (!employee) return;

    const recipients: UserContact[] =
      actor.id === row.userId
        ? [
            {
              id: group.mainApprovalUserId,
              name: group.mainApprovalUserName,
              email: group.mainApprovalUserEmail,
            },
            {
              id: group.tempApprovalUserId,
              name: group.tempApprovalUserName,
              email: group.tempApprovalUserEmail,
            },
          ].filter(
            (a): a is UserContact =>
              Boolean(a.id) && Boolean(a.name) && Boolean(a.email) && a.id !== actor.id
          )
        : [employee];

    const unique = [...new Map(recipients.map((r) => [r.id, r])).values()];

    await deliver(
      unique.map((recipient) => ({
        userId: recipient.id,
        email: {
          to: recipient.email,
          template: "vacation-cancelled",
          data: {
            recipientName: recipient.name,
            employeeName: employee.name,
            cancelledByName: actor.name,
            teamName: group.groupName,
            leaveType: summary.leaveType,
            dateRange: summary.dateRange,
            dayCount: summary.dayCount,
            reason: reason?.trim() ? reason.trim() : OR_DASH,
            requestUrl: summary.requestUrl,
          },
        },
        notification: {
          type: notificationType.ApprovalDecided,
          title: "Approved time off cancelled",
          body: `${employee.name} · ${summary.leaveType} · ${summary.dateRange}`,
          href: summary.requestUrl,
        },
      }))
    );
  } catch (error) {
    logger.error("notifyVacationCancelled failed", { error, vacationId: row.id });
  }
};

/**
 * Bulk variant of {@link notifyVacationCancelled} for cancelling a whole
 * multi-day request. Only the days that had already been approved are worth an
 * email; rows are grouped per requester so each affected employee (or their
 * approvers, when the employee cancels their own days) gets one mail covering
 * their cancelled span.
 */
export const notifyVacationsCancelled = async (
  rows: (VacationRow & { approvedAt: Date | null })[],
  actor: { id: string; name: string },
  reason: string | null
): Promise<void> => {
  try {
    const approvedRows = rows.filter((r) => r.approvedAt);
    if (approvedRows.length === 0) return;

    const byUser = groupByUser(approvedRows);
    const employees = await services.user.getUsersByIds([...byUser.keys()]);
    const contacts = new Map(employees.map((e) => [e.id, e]));

    const deliveries: Delivery[] = [];

    for (const [userId, userRows] of byUser) {
      const employee = contacts.get(userId);
      const summary = summarize(userRows);
      if (!employee || !summary) continue;

      const group = await services.group.getApprovalUsers(userRows[0]?.groupId ?? "");
      if (!group) continue;

      const recipients: UserContact[] =
        actor.id === userId
          ? [
              {
                id: group.mainApprovalUserId,
                name: group.mainApprovalUserName,
                email: group.mainApprovalUserEmail,
              },
              {
                id: group.tempApprovalUserId,
                name: group.tempApprovalUserName,
                email: group.tempApprovalUserEmail,
              },
            ].filter(
              (a): a is UserContact =>
                Boolean(a.id) && Boolean(a.name) && Boolean(a.email) && a.id !== actor.id
            )
          : [employee];

      const unique = [...new Map(recipients.map((r) => [r.id, r])).values()];

      for (const recipient of unique) {
        deliveries.push({
          userId: recipient.id,
          email: {
            to: recipient.email,
            template: "vacation-cancelled",
            data: {
              recipientName: recipient.name,
              employeeName: employee.name,
              cancelledByName: actor.name,
              teamName: group.groupName,
              leaveType: summary.leaveType,
              dateRange: summary.dateRange,
              dayCount: summary.dayCount,
              reason: reason?.trim() ? reason.trim() : OR_DASH,
              requestUrl: summary.requestUrl,
            },
          },
          notification: {
            type: notificationType.ApprovalDecided,
            title: "Approved time off cancelled",
            body: `${employee.name} · ${summary.leaveType} · ${summary.dateRange}`,
            href: summary.requestUrl,
          },
        });
      }
    }

    await deliver(deliveries);
  } catch (error) {
    logger.error("notifyVacationsCancelled failed", { error, actorId: actor.id });
  }
};
