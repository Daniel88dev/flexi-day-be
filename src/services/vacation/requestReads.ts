import type { AuthSession } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import type { DateString } from "../../utils/dateFunc.js";
import {
  holdsAttachmentSlot,
  listAttachmentsForRequest,
} from "../attachment/attachmentServices.js";
import { isRequestPastRetention } from "../attachment/attachmentRetention.js";
import { MAX_ATTACHMENTS_PER_REQUEST } from "../attachment/types.js";
import { isAttachmentUploadAvailable } from "../billing/guards.js";
import { filterGroupIdsByOrganization, getGroup } from "../group/groupServices.js";
import { DELETED_ACCOUNT_NAME, getActorNames } from "../person/personName.js";
import { canViewWholeGroup } from "../report/reportScope.js";
import { getReportScopeEntries } from "../report/reportServices.js";
import { getVacationEvents } from "../vacationEvent/vacationEventServices.js";
import { viewVacationRowAs } from "./redaction.js";
import type { VacationDetail } from "./types.js";
import {
  resolveCanApproveForList,
  resolveVacationPermissions,
  resolveVacationViewer,
  type VacationPermissions,
} from "./vacationPermissions.js";
import {
  getVacationDetailById,
  getVacationsForGroup,
  getVacationsForUser,
  type VacationListOptions,
} from "./vacationServices.js";

/** `endDate` itself is excluded. */
export type RequestListRange = { startDate: DateString; endDate: DateString };

/**
 * The caller's own rows in every group, or only the live groups of
 * `organizationId` when given, each with whether the caller may approve it.
 */
export const listOwnRequests = async (params: {
  auth: AuthSession;
  range: RequestListRange;
  options: VacationListOptions;
  organizationId?: string;
}) => {
  const { auth, range, options, organizationId } = params;

  const all = await getVacationsForUser(auth.userId, range.startDate, range.endDate, options);
  const result =
    organizationId === undefined ? all : await keepOrganizationRows(all, organizationId);
  const canApprove = await resolveCanApproveForList(auth.userId, result);
  // Same shape as `listWhoIsAway`, so clients do not branch on scope.
  return result.map((row) => ({
    ...row,
    mirroredFromGroupId: null,
    mirroredFromGroupName: null,
    canApprove: canApprove(row),
  }));
};

/**
 * {@link listOwnRequests} in one organization, each rejected row with the name
 * of whoever rejected it. `rejectedBy` goes null with the rejecter's account
 * row, and the reason they wrote stays: that row reads "Deleted account".
 */
export const listOwnRequestsWithRejecter = async (params: {
  auth: AuthSession;
  range: RequestListRange;
  options: VacationListOptions;
  organizationId: string;
}) => {
  const rows = await listOwnRequests(params);
  const nameOf = await getActorNames(
    rows.map((row) => row.rejectedBy),
    { organizationId: params.organizationId }
  );
  return rows.map((row) => ({
    ...row,
    rejectedByName: row.rejectedAt ? (nameOf(row.rejectedBy) ?? DELETED_ACCOUNT_NAME) : null,
  }));
};

const keepOrganizationRows = async <T extends { groupId: string }>(
  rows: T[],
  organizationId: string
): Promise<T[]> => {
  const inside = new Set(
    await filterGroupIdsByOrganization([...new Set(rows.map((row) => row.groupId))], organizationId)
  );
  return rows.filter((row) => inside.has(row.groupId));
};

/**
 * The groups of one organization whose whole calendar the caller may view:
 * those `listWhoIsAway` answers for.
 */
export const listViewableGroups = async (params: {
  auth: AuthSession;
  organizationId: string;
}): Promise<{ groupId: string; groupName: string }[]> => {
  const { auth, organizationId } = params;
  const viewable = (await getReportScopeEntries(auth.userId)).filter(
    (entry) => entry.access === "all"
  );
  const inside = new Set(
    await filterGroupIdsByOrganization(
      viewable.map((entry) => entry.groupId),
      organizationId
    )
  );
  return viewable
    .filter((entry) => inside.has(entry.groupId))
    .map(({ groupId, groupName }) => ({ groupId, groupName }));
};

/** A group's rows, for a caller who may view the whole group, redacted to what they may see. */
export const listWhoIsAway = async (params: {
  auth: AuthSession;
  groupId: string;
  range: RequestListRange;
  options: VacationListOptions;
}) => {
  const { auth, groupId, range, options } = params;

  const scope = await getReportScopeEntries(auth.userId);
  if (!canViewWholeGroup(scope, groupId)) {
    throw new AppError({
      code: 403,
      message: "No access to view this group's records",
      logging: true,
      context: { userId: auth.userId, groupId },
    });
  }

  const result = await getVacationsForGroup(groupId, range.startDate, range.endDate, null, options);
  const canApprove = await resolveCanApproveForList(auth.userId, result);
  const viewer = await resolveVacationViewer(
    auth.userId,
    result.map((row) => row.groupId)
  );

  const visible = result.flatMap((row) => {
    const seen = viewVacationRowAs(viewer, row);
    return seen ? [{ ...seen, canApprove: canApprove(row) }] : [];
  });
  return options.wholeRequests ? keepRequestsVisibleInRange(visible, range) : visible;
};

/** `listOwnRequests` without a group, `listWhoIsAway` with one. */
export const listVacationsInScope = (params: {
  auth: AuthSession;
  groupId: string | undefined;
  range: RequestListRange;
  options: VacationListOptions;
}) => {
  const { groupId, ...rest } = params;
  return groupId === undefined ? listOwnRequests(rest) : listWhoIsAway({ ...rest, groupId });
};

// The service picks Requests by their raw in-range rows. A teammate may not see those rows
// (rejected, cancelled), and then gets none of that Request's rows from other months either.
const keepRequestsVisibleInRange = <T extends { requestId: string; requestedDay: string }>(
  rows: T[],
  range: RequestListRange
): T[] => {
  const inRange = new Set(
    rows
      .filter((row) => row.requestedDay >= range.startDate && row.requestedDay < range.endDate)
      .map((row) => row.requestId)
  );
  return rows.filter((row) => inRange.has(row.requestId));
};

/**
 * The Request's attachments and whether this caller may add one right now:
 * standing, plan, the per-request cap and retention together, so the client
 * never offers an upload the create endpoint would refuse.
 */
const attachmentsFor = async (detail: VacationDetail, permissions: VacationPermissions) => {
  const attachments = await listAttachmentsForRequest(detail.requestId);
  const slotsUsed = attachments.filter(
    (a) => a.deletedAt === null && holdsAttachmentSlot(a.status)
  ).length;
  const group = permissions.canAttach ? await getGroup(detail.groupId) : undefined;
  const uploadsAvailable = group ? await isAttachmentUploadAvailable(group.organizationId) : false;
  const open =
    permissions.canAttach &&
    uploadsAvailable &&
    slotsUsed < MAX_ATTACHMENTS_PER_REQUEST &&
    !(await isRequestPastRetention(detail.requestId));
  return {
    attachments,
    canAttach: open,
    canDeleteAnyAttachment: permissions.canDeleteAnyAttachment,
  };
};

/**
 * One request with its full audit trail (who asked, who decided, who
 * cancelled) plus the actions this caller is allowed to take on it.
 */
export const getRequestDetail = async (params: { auth: AuthSession; vacationId: string }) => {
  const { auth, vacationId } = params;

  const detail = await getVacationDetailById(vacationId);

  if (!detail) {
    throw new AppError({
      code: 404,
      message: "Vacation not found",
      context: { userId: auth.userId, vacationId },
    });
  }

  const permissions = await resolveVacationPermissions(auth.userId, detail);
  const seen = permissions.canView
    ? viewVacationRowAs(
        {
          userId: auth.userId,
          privilegedGroupIds: new Set(permissions.canReadPrivateDetails ? [detail.groupId] : []),
        },
        detail
      )
    : null;

  if (!seen) {
    throw new AppError({
      code: 403,
      message: "You are not allowed to view this vacation",
      logging: true,
      context: { userId: auth.userId, vacationId },
    });
  }

  const history = permissions.canReadPrivateDetails ? await getVacationEvents(vacationId) : [];

  // Absent, not empty, for a view-only member: they may see the day, not the file.
  const attachmentFields = permissions.canViewAttachments
    ? await attachmentsFor(detail, permissions)
    : {};

  return {
    ...seen,
    canApprove: permissions.canApprove,
    canCancel: permissions.canCancel,
    canEdit: permissions.canEdit,
    canReadPrivateDetails: permissions.canReadPrivateDetails,
    history,
    ...attachmentFields,
  };
};
