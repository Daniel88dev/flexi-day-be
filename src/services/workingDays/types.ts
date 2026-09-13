/** Why nobody is expected at work on a date. */
export enum NonWorkingDayCause {
  /** Not one of the `workingDays` the organization or group keeps. */
  NonWorkingDay = "NON_WORKING_DAY",
  Holiday = "HOLIDAY",
}

export type NonWorkingDay = {
  cause: NonWorkingDayCause;
  /** The holiday's name, in the country's own language. Null for a day of the week nobody works. */
  name: string | null;
};

/**
 * The two settings that decide it. Both an organization's attendance settings
 * and a group's own columns satisfy this, which is the point — the rule is
 * written once and read by whichever of them is asking.
 */
export type WorkingDayRules = {
  /** `Date.getUTCDay()` numbers, 0=Sun … 6=Sat. */
  workingDays: number[];
  /** Null disables holidays entirely: no country, no day off. */
  holidayCountry: string | null;
};
