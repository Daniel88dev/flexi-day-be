type QuotaValues = {
  vacationDays: number;
  homeOfficeDays: number;
  sickDays: number;
  carriedOverDays: number;
};

const FIELDS: { label: string; read: (values: QuotaValues) => number }[] = [
  { label: "vacation", read: (v) => v.vacationDays },
  { label: "home office", read: (v) => v.homeOfficeDays },
  { label: "sick day", read: (v) => v.sickDays },
  { label: "carried over", read: (v) => v.carriedOverDays },
];

/**
 * Human-readable audit line for a quota write. Rendered verbatim in the
 * member detail change log, so it has to make sense without the surrounding
 * row: it names the year and only the values that actually moved.
 */
export const describeQuotaChange = (
  relatedYear: string,
  previous: QuotaValues | undefined,
  next: QuotaValues
): string => {
  if (!previous) {
    return (
      `Quota for ${relatedYear} set to ${next.vacationDays.toString()} vacation / ` +
      `${next.homeOfficeDays.toString()} home office / ` +
      `${next.sickDays.toString()} sick days, ` +
      `${next.carriedOverDays.toString()} carried over from the previous year`
    );
  }

  const diffs = FIELDS.filter(({ read }) => read(previous) !== read(next)).map(
    ({ label, read }) => `${label} ${read(previous).toString()} → ${read(next).toString()}`
  );

  if (diffs.length === 0) {
    return `Quota for ${relatedYear} re-saved with no change`;
  }

  return `Quota for ${relatedYear}: ${diffs.join(", ")}`;
};
