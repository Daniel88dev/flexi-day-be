import { vacationType } from "../../db/schema/vacation-schema.js";
import type { VacationType } from "./types.js";
import type { VacationUpdatePatch } from "./vacationServices.js";

const TYPE_LABELS: Record<vacationType, string> = {
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

const orDash = (value: string | null | undefined): string => (value?.length ? value : "—");

type EditableRow = Pick<
  VacationType,
  "startTime" | "endTime" | "vacationType" | "halfDay" | "note"
>;

/**
 * Human-readable summary of an in-place edit, stored as the UPDATED event's
 * `reason`. Rendered verbatim on the request timeline, so it names only the
 * fields that actually changed.
 */
export const describeVacationChanges = (
  previous: EditableRow,
  patch: VacationUpdatePatch
): string => {
  const diffs: string[] = [];

  if (patch.vacationType !== undefined && patch.vacationType !== previous.vacationType) {
    diffs.push(`Type: ${TYPE_LABELS[previous.vacationType]} → ${TYPE_LABELS[patch.vacationType]}`);
  }
  if (patch.halfDay !== undefined && patch.halfDay !== previous.halfDay) {
    diffs.push(`Half day: ${previous.halfDay ? "yes" : "no"} → ${patch.halfDay ? "yes" : "no"}`);
  }

  const startChanged = patch.startTime !== undefined && patch.startTime !== previous.startTime;
  const endChanged = patch.endTime !== undefined && patch.endTime !== previous.endTime;
  if (startChanged || endChanged) {
    const fromStart = orDash(previous.startTime);
    const fromEnd = orDash(previous.endTime);
    const toStart = orDash(patch.startTime !== undefined ? patch.startTime : previous.startTime);
    const toEnd = orDash(patch.endTime !== undefined ? patch.endTime : previous.endTime);
    diffs.push(`Time: ${fromStart}–${fromEnd} → ${toStart}–${toEnd}`);
  }

  if (patch.note !== undefined && (patch.note ?? null) !== previous.note) {
    diffs.push(
      patch.note === null ? "Note removed" : previous.note ? "Note updated" : "Note added"
    );
  }

  return diffs.length > 0 ? diffs.join("; ") : "Re-saved with no change";
};
