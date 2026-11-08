import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { getGroup } from "../group/groupServices.js";
import { allowanceStandings, type AllowanceStanding } from "./quotaGuard.js";
import {
  createRequest,
  previewCreateRequest,
  type RequestCreationPreview,
} from "./requestCreation.js";
import {
  REQUESTABLE_CALENDAR_RECORD_TYPES,
  validatePostVacation,
  type LiveVacationType,
  type VacationType,
} from "./types.js";
import { cancelRequestBatch, previewCancelRequestBatch } from "./vacationTransitions.js";

// The caller's own Requests inside one organization, for AI connections and the
// Assistant: nobody else's, whatever wider rights the caller holds in the app.

export type OwnRequestInput = {
  groupId?: string;
  from: string;
  to: string;
  /** Defaults to VACATION. */
  vacationType?: (typeof REQUESTABLE_CALENDAR_RECORD_TYPES)[number];
  halfDay: boolean;
  note: string | null;
};

type Scope = { auth: AuthSession; organizationId: string };

/** The named group, else the one group in the organization where the caller books leave. */
const bookingGroupOf = async (
  { auth, organizationId }: Scope,
  groupId: string | undefined
): Promise<string> => {
  if (groupId !== undefined) return groupId;
  const rows = await db
    .select({ id: groups.id })
    .from(groupUsers)
    .innerJoin(groups, eq(groups.id, groupUsers.groupId))
    .where(
      and(
        eq(groupUsers.userId, auth.userId),
        eq(groupUsers.controlledUser, true),
        isNull(groupUsers.deletedAt),
        eq(groups.organizationId, organizationId),
        isNull(groups.deletedAt)
      )
    )
    .orderBy(asc(groups.createdAt));
  const [only] = rows;
  if (rows.length === 1 && only) return only.id;
  if (rows.length === 0) {
    throw new AppError({
      message: "No access for related group",
      logging: true,
      code: 403,
      context: { userId: auth.userId, organizationId },
    });
  }
  throw new AppError({
    message: "You book time off in more than one group here, so the group has to be named",
    code: 422,
    context: { userId: auth.userId, organizationId },
    publicContext: { code: "GROUP_REQUIRED", groupIds: rows.map((row) => row.id) },
  });
};

const postInputOf = (groupId: string, input: OwnRequestInput) => {
  const parsed = validatePostVacation.safeParse({
    groupId,
    from: input.from,
    to: input.to,
    vacationType: input.vacationType,
    halfDay: input.halfDay,
    note: input.note,
  });
  if (!parsed.success) {
    throw new AppError({
      message: "This request is not valid",
      code: 422,
      context: { fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  return parsed.data;
};

/** Books a Request for the caller alone: never on someone's behalf, never approved on creation. */
export const createOwnRequest = async (
  params: Scope & { input: OwnRequestInput }
): Promise<VacationType[]> => {
  const groupId = await bookingGroupOf(params, params.input.groupId);
  return createRequest({ auth: params.auth, input: postInputOf(groupId, params.input) });
};

/** {@link createOwnRequest} as a dry run: the same guards, nothing written. */
export const previewOwnRequest = async (
  params: Scope & { input: OwnRequestInput }
): Promise<RequestCreationPreview> => {
  const groupId = await bookingGroupOf(params, params.input.groupId);
  return previewCreateRequest({ auth: params.auth, input: postInputOf(groupId, params.input) });
};

/** The live, undecided-or-approved days of one of the caller's own Requests in the organization. */
const ownRequestDayIds = async ({ auth, organizationId }: Scope, requestId: string) => {
  const rows = await db
    .select({ id: vacation.id })
    .from(vacation)
    .innerJoin(groups, eq(groups.id, vacation.groupId))
    .where(
      and(
        eq(vacation.requestId, requestId),
        eq(vacation.userId, auth.userId),
        isNull(vacation.deletedAt),
        isNull(vacation.rejectedAt),
        eq(groups.organizationId, organizationId)
      )
    );
  if (rows.length === 0) {
    throw new AppError({
      message: "Request not found",
      code: 404,
      context: { userId: auth.userId, organizationId, requestId },
    });
  }
  return rows.map((row) => row.id);
};

/** Cancels every live day of the caller's own Request, through the cancel transition. */
export const cancelOwnRequest = async (
  params: Scope & { requestId: string; reason: string | null }
): Promise<VacationType[]> =>
  cancelRequestBatch({
    auth: params.auth,
    vacationIds: await ownRequestDayIds(params, params.requestId),
    reason: params.reason,
  });

export type OwnCancellationPreview = {
  group: { id: string; name: string };
  /** The days that would be cancelled, oldest first. */
  rows: LiveVacationType[];
  /** The allowances the cancelled days count against now; empty for a type without one. */
  allowances: AllowanceStanding[];
};

/** {@link cancelOwnRequest} as a dry run: the same guards, nothing changed. */
export const previewCancelOwnRequest = async (
  params: Scope & { requestId: string }
): Promise<OwnCancellationPreview> => {
  const rows = await previewCancelRequestBatch({
    auth: params.auth,
    vacationIds: await ownRequestDayIds(params, params.requestId),
  });
  rows.sort((a, b) => a.requestedDay.localeCompare(b.requestedDay));
  const allowances = await db.transaction((tx) => allowanceStandings(rows, tx));
  const group = await getGroup(rows[0]!.groupId);
  return {
    group: { id: rows[0]!.groupId, name: group?.groupName ?? "" },
    rows,
    allowances,
  };
};
