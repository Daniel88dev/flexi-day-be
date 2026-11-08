import type { RequestStatus } from "../reads/requestRows.js";

export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

/** Ends every write tool's description. */
export const WRITE_NOTE =
  " It changes Flexi Day data: call it only when the user asked for this change.";

/**
 * Where one allowance stands before and after a write. `available` is what the
 * booking guard checks against: allocated minus approved minus pending days.
 * (The app's "remaining" subtracts approved days only.)
 */
export type AllowanceChange = {
  year: number;
  type: string;
  allocated: number;
  approved: number;
  pending: number;
  availableBefore: number;
  availableAfter: number;
};

/**
 * The `details` of every write tool's preview, one shape per tool, keyed by
 * `action`. Confirmation cards are built from these, never from the model's
 * words. Strings people wrote arrive wrapped as `{"user_text": "…"}` at the
 * tool's `preview.userText` paths.
 */
export type WritePreview =
  | {
      action: "create_request";
      group: { id: string; name: string };
      type: string;
      firstDay: string;
      lastDay: string;
      halfDay: boolean;
      /** The days that would be booked: the range without non-working days and holidays. */
      bookedDays: string[];
      /** Weighted: a half day counts 0.5. */
      days: number;
      note: string | null;
      allowances: AllowanceChange[];
    }
  | {
      action: "cancel_my_request";
      requestId: string;
      group: { id: string; name: string };
      type: string;
      status: Exclude<RequestStatus, "rejected" | "cancelled"> | "partly_approved";
      firstDay: string;
      lastDay: string;
      cancelledDays: string[];
      days: number;
      note: string | null;
      reason: string | null;
      allowances: AllowanceChange[];
    }
  | {
      action: "clock_in";
      /** The instant the preview ran; the write stamps its own. */
      at: string;
      businessDate: string;
      timezone: string;
    }
  | {
      action: "clock_out";
      at: string;
      startedAt: string;
      businessDate: string;
      timezone: string;
      /** An open break ends with the session. */
      onBreak: boolean;
      /** From the session's start to `at`, breaks included. */
      sessionMinutes: number;
    };

type Standing = {
  year: number;
  vacationType: string;
  allocated: number;
  approved: number;
  pending: number;
  days: number;
};

const round = (value: number) => Number(value.toFixed(2));

/** `sign` is -1 when the write books the days, +1 when it gives them back. */
export const allowanceChanges = (standings: Standing[], sign: 1 | -1): AllowanceChange[] =>
  standings.map((standing) => {
    const availableBefore = round(standing.allocated - standing.approved - standing.pending);
    return {
      year: standing.year,
      type: standing.vacationType,
      allocated: standing.allocated,
      approved: standing.approved,
      pending: standing.pending,
      availableBefore,
      availableAfter: round(availableBefore + sign * standing.days),
    };
  });

export const weightedDays = (rows: { halfDay: boolean }[]) =>
  rows.reduce((total, row) => total + (row.halfDay ? 0.5 : 1), 0);
