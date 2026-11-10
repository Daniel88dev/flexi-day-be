import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { getActorNames } from "../person/personName.js";
import { collapsePendingApprovals } from "./collapsePendingApprovals.js";
import type { Decision } from "./decisionGuards.js";
import { allowanceStandings, type AllowanceStanding } from "./quotaGuard.js";
import type { LiveVacationType, VacationType } from "./types.js";
import {
  approveRequestBatch,
  previewDecisionBatch,
  rejectRequestBatch,
} from "./vacationTransitions.js";
import { getPendingApprovalsForApprover } from "./vacationServices.js";

// Decisions on other people's Requests inside one organization, for the
// Assistant. A Request is decided whole: every day of it still waiting.

type Scope = { auth: AuthSession; organizationId: string };

type Person = { id: string; name: string };

export type RequestToApprove = {
  requestId: string;
  requester: Person;
  group: { id: string; name: string };
  type: string;
  firstDay: string;
  lastDay: string;
  /** The waiting days, oldest first. */
  days: string[];
  note: string | null;
  /** Who wrote the note: whoever booked the Request, the requester or someone on their behalf. */
  noteAuthor: Person | null;
  submittedAt: string;
};

/** The Requests waiting on the caller's decision in the organization, as the Approvals widget lists them. */
export const listRequestsToApprove = async ({
  auth,
  organizationId,
}: Scope): Promise<RequestToApprove[]> => {
  const rows = await getPendingApprovalsForApprover(auth.userId, { organizationId });
  const requestIdOf = new Map(rows.map((row) => [row.vacationId, row.requestId]));
  const creatorOf = new Map(rows.map((row) => [row.requestId, row.createdByUserId]));
  const nameOf = await getActorNames(
    rows.map((row) => row.createdByUserId),
    { organizationId }
  );
  const daysOf = new Map<string, string[]>();
  for (const row of rows) {
    daysOf.set(row.requestId, [...(daysOf.get(row.requestId) ?? []), row.requestedDay]);
  }
  return collapsePendingApprovals(rows).map((entry) => {
    const requestId = requestIdOf.get(entry.vacationIds[0]!)!;
    const requester = { id: entry.user.id, name: entry.user.name };
    const creator = creatorOf.get(requestId) ?? null;
    return {
      requestId,
      requester,
      group: { id: entry.groupId, name: entry.groupName },
      type: entry.vacationType,
      firstDay: entry.from,
      lastDay: entry.to,
      days: (daysOf.get(requestId) ?? []).sort(),
      note: entry.note,
      noteAuthor: entry.note
        ? creator && creator !== requester.id
          ? { id: creator, name: nameOf(creator) ?? "" }
          : requester
        : null,
      submittedAt: entry.submittedAt,
    };
  });
};

/**
 * The days a decision on the Request covers: every live day of it in the
 * organization still waiting, or, when none waits, every live day, so the
 * transition's own guards answer (403 for a non-approver, 409 once decided).
 */
const decisionDayIds = async ({ auth, organizationId }: Scope, requestId: string) => {
  const rows = await db
    .select({ id: vacation.id, approvedAt: vacation.approvedAt, rejectedAt: vacation.rejectedAt })
    .from(vacation)
    .innerJoin(groups, eq(groups.id, vacation.groupId))
    .where(
      and(
        eq(vacation.requestId, requestId),
        isNull(vacation.deletedAt),
        eq(groups.organizationId, organizationId),
        isNull(groups.deletedAt)
      )
    );
  if (rows.length === 0) {
    throw new AppError({
      message: "Request not found",
      code: 404,
      context: { userId: auth.userId, organizationId, requestId },
    });
  }
  const waiting = rows.filter((row) => row.approvedAt === null && row.rejectedAt === null);
  return (waiting.length > 0 ? waiting : rows).map((row) => row.id);
};

export const approveRequestInOrganization = async (
  params: Scope & { requestId: string }
): Promise<VacationType[]> =>
  approveRequestBatch({
    auth: params.auth,
    vacationIds: await decisionDayIds(params, params.requestId),
    reason: null,
  });

export const rejectRequestInOrganization = async (
  params: Scope & { requestId: string; reason: string | null }
): Promise<VacationType[]> =>
  rejectRequestBatch({
    auth: params.auth,
    vacationIds: await decisionDayIds(params, params.requestId),
    reason: params.reason,
  });

export type DecisionPreview = {
  requester: Person;
  group: { id: string; name: string };
  /** The days that would be decided, oldest first. */
  rows: LiveVacationType[];
  noteAuthor: Person | null;
  /** The requester's allowances these days count against; empty for a type without one. */
  allowances: AllowanceStanding[];
};

/** A decision on the Request as a dry run: the transition's guards, nothing changed. */
export const previewRequestDecision = async (
  params: Scope & { requestId: string; decision: Decision }
): Promise<DecisionPreview> => {
  const rows = await previewDecisionBatch({
    auth: params.auth,
    vacationIds: await decisionDayIds(params, params.requestId),
    decision: params.decision,
  });
  rows.sort((a, b) => a.requestedDay.localeCompare(b.requestedDay));
  const first = rows[0]!;
  const allowances = await db.transaction((tx) => allowanceStandings(rows, tx));
  const [group] = await db
    .select({ name: groups.groupName })
    .from(groups)
    .where(eq(groups.id, first.groupId));
  const scope = { groupId: first.groupId };
  const nameOf = await getActorNames([first.userId, first.createdByUserId], scope);
  const requester = { id: first.userId, name: nameOf(first.userId) ?? "" };
  const author = first.createdByUserId ?? first.userId;
  const note = rows.find((row) => row.note)?.note ?? null;
  return {
    requester,
    group: { id: first.groupId, name: group?.name ?? "" },
    rows,
    noteAuthor: note ? { id: author, name: nameOf(author) ?? "" } : null,
    allowances,
  };
};
