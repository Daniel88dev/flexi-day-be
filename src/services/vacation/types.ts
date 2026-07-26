import type { DateString } from "../../utils/dateFunc.js";
import { z } from "zod";
import { vacationType } from "../../db/schema/vacation-schema.js";
import type { UserSummary } from "../../utils/userPresentation.js";

export type VacationType = {
  id: string;
  userId: string;
  groupId: string;
  requestedDay: DateString;
  startTime: string | null;
  endTime: string | null;
  vacationType: vacationType;
  approvedAt: Date | null;
  approvedBy: string | null;
  deletedAt: Date | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type VacationInsertType = Pick<
  VacationType,
  "id" | "userId" | "groupId" | "requestedDay" | "startTime" | "endTime" | "vacationType"
> & {
  note?: string | null;
};

export type VacationListItem = VacationType & {
  user: UserSummary;
};

/**
 * A single request as shown on the detail view: the row, who it belongs to,
 * which group it was booked in, and who decided on it.
 */
export type VacationDetail = VacationListItem & {
  groupName: string;
  approvedByUser: UserSummary | null;
  rejectedByUser: UserSummary | null;
  // The contiguous same-type run this row belongs to: inclusive span + every day-row id in it.
  rangeStart: DateString;
  rangeEnd: DateString;
  vacationIds: string[];
};

/** Optional cancellation reason, accepted on DELETE /api/vacation/:id. */
export const validateCancelVacation = z
  .object({
    reason: z.string().max(1000).optional(),
  })
  .nullish()
  .transform((value) => value ?? {});

export type ValidatedCancelVacationType = z.infer<typeof validateCancelVacation>;

const vacationKindEnum = z.enum(Object.values(vacationType) as [vacationType, ...vacationType[]]);

export const validatePostVacation = z.object({
  groupId: z.uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  vacationType: vacationKindEnum.default(vacationType.Vacation),
  startTime: z.iso.time().nullable().default(null),
  endTime: z.iso.time().nullable().default(null),
  note: z.string().max(1000).nullable().default(null),
});

export type ValidatedPostVacationType = z.infer<typeof validatePostVacation>;

// Reject and cancel both take an optional reason, so clients legitimately send
// no body at all — in which case express leaves `req.body` undefined. Accept
// that and normalise it to an empty object rather than failing validation.
export const validateRejectVacation = z
  .object({
    reason: z.string().max(1000).optional(),
  })
  .nullish()
  .transform((value) => value ?? {});

export type ValidatedRejectVacationType = z.infer<typeof validateRejectVacation>;

// Approve optionally carries a note that is stored on the timeline event, so —
// like reject/cancel — a missing body is normalised to an empty object.
export const validateApproveVacation = z
  .object({
    reason: z.string().max(1000).optional(),
  })
  .nullish()
  .transform((value) => value ?? {});

export type ValidatedApproveVacationType = z.infer<typeof validateApproveVacation>;

// A comment always carries a message — an empty comment is meaningless.
export const validateCommentVacation = z.object({
  message: z.string().trim().min(1).max(1000),
});

export type ValidatedCommentVacationType = z.infer<typeof validateCommentVacation>;

const ids = z.array(z.uuid()).min(1).max(366);

export const validateBulkApproveVacation = z.object({
  ids,
});

export type ValidatedBulkApproveVacationType = z.infer<typeof validateBulkApproveVacation>;

export const validateBulkRejectVacation = z.object({
  ids,
  reason: z.string().max(1000).optional(),
});

export type ValidatedBulkRejectVacationType = z.infer<typeof validateBulkRejectVacation>;

export const validateBulkCancelVacation = z.object({
  ids,
  reason: z.string().max(1000).optional(),
});

export type ValidatedBulkCancelVacationType = z.infer<typeof validateBulkCancelVacation>;
