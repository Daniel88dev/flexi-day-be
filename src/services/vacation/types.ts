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
  halfDay: boolean;
  approvedAt: Date | null;
  approvedBy: string | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  note: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A row a live-only reader returned: its `deleted_at IS NULL` predicate, as a type. */
export type LiveVacationType = Omit<VacationType, "deletedAt"> & { deletedAt: null };

export type VacationInsertType = Pick<
  VacationType,
  | "id"
  | "userId"
  | "groupId"
  | "requestedDay"
  | "startTime"
  | "endTime"
  | "vacationType"
  | "halfDay"
  | "createdByUserId"
> & {
  note?: string | null;
  approvedAt?: Date;
  approvedBy?: string;
};

export type VacationListItem = VacationType & {
  user: UserSummary;
};

/**
 * A record as seen from one group's perspective. `mirroredFromGroupId` is null
 * for the group's own records; when set, the record is only projected here from
 * that group and is read-only — it is approved, counted and reported in its
 * source group alone.
 */
export type GroupVacationListItem = VacationListItem & {
  mirroredFromGroupId: string | null;
  mirroredFromGroupName: string | null;
};

/**
 * A single request as shown on the detail view: the row, who it belongs to,
 * which group it was booked in, and who decided on it.
 */
export type VacationDetail = VacationListItem & {
  groupName: string;
  approvedByUser: UserSummary | null;
  rejectedByUser: UserSummary | null;
  createdByUser: UserSummary | null;
  deletedByUser: UserSummary | null;
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

/**
 * `BANK_HOLIDAY` is deliberately absent: it is a company-wide closure owned by
 * the admin `bankHolidayRouter`, costs no allowance, and shows to the whole team
 * unattributed, so nobody may grant themselves one.
 */
export const REQUESTABLE_VACATION_TYPES = Object.values(vacationType).filter(
  (kind) => kind !== vacationType.BankHoliday
) as [vacationType, ...vacationType[]];

const requestableKindEnum = z.enum(REQUESTABLE_VACATION_TYPES);

export const validatePostVacation = z
  .object({
    groupId: z.uuid(),
    // Book on behalf of this member instead of the caller. Requires group
    // admin rights; the handler authorizes it. Plain string, not uuid: real
    // accounts carry better-auth's 32-char alphanumeric ids.
    userId: z.string().min(1).optional(),
    from: z.coerce.date(),
    to: z.coerce.date(),
    vacationType: requestableKindEnum.default(vacationType.Vacation),
    startTime: z.iso.time().nullable().default(null),
    endTime: z.iso.time().nullable().default(null),
    // Drives quota accounting (0.5 vs 1 day). Deliberately explicit — the
    // optional start/end times above are free-form and cannot stand in for it.
    halfDay: z.boolean().default(false),
    note: z.string().max(1000).nullable().default(null),
    autoApprove: z.boolean().default(false),
  })
  .refine((data) => !(data.startTime && data.endTime) || data.endTime > data.startTime, {
    message: "`endTime` must be later than `startTime`",
    path: ["endTime"],
  })
  .refine((data) => !data.halfDay || data.from.getTime() === data.to.getTime(), {
    message: "`halfDay` is only valid for a single-day request",
    path: ["halfDay"],
  })
  .refine((data) => !data.autoApprove || data.userId !== undefined, {
    message: "`autoApprove` is only valid when booking on behalf of a member",
    path: ["autoApprove"],
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

/**
 * Admin edit of existing day rows. Only per-day presentation and accounting
 * fields are editable — moving a record to another day is a cancel + re-create,
 * which keeps the partial `uniq_vacation_user_day` index authoritative.
 */
export const validateUpdateVacation = z
  .object({
    ids,
    vacationType: requestableKindEnum.optional(),
    startTime: z.iso.time().nullable().optional(),
    endTime: z.iso.time().nullable().optional(),
    halfDay: z.boolean().optional(),
    note: z.string().max(1000).nullable().optional(),
  })
  .refine(
    (data) =>
      data.vacationType !== undefined ||
      data.startTime !== undefined ||
      data.endTime !== undefined ||
      data.halfDay !== undefined ||
      data.note !== undefined,
    { message: "At least one field to update is required" }
  )
  .refine((data) => !(data.startTime && data.endTime) || data.endTime > data.startTime, {
    message: "`endTime` must be later than `startTime`",
    path: ["endTime"],
  })
  .refine((data) => data.halfDay !== true || new Set(data.ids).size === 1, {
    message: "`halfDay` is only valid for a single-day record",
    path: ["halfDay"],
  });

export type ValidatedUpdateVacationType = z.infer<typeof validateUpdateVacation>;
