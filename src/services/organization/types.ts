import { z } from "zod";
import type { UserSummary } from "../../utils/userPresentation.js";
import { isSupportedCountry } from "../bankHoliday/holidayDataset.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";

export type OrganizationType = {
  id: string;
  name: string;
  ownerUserId: string;
  billingEmail: string;
  paddleCustomerId: string | null;
  sickDayBenefitEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type OrganizationAdminListItem = {
  userId: string;
  email: string;
  /** The owner is synthesised from `organizations.ownerUserId`, not stored. */
  isOwner: boolean;
  grantedAt: Date | null;
  user: UserSummary;
};

export type OrganizationCandidate = {
  userId: string;
  email: string;
  groupNames: string[];
  user: UserSummary;
};

export const validatePatchOrganization = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Normalise before validating: `z.email()` runs first in a chain, so a
    // trailing space would be rejected rather than trimmed away.
    billingEmail: z.string().trim().toLowerCase().pipe(z.email().max(320)).optional(),
    sickDayBenefitEnabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.billingEmail !== undefined ||
      body.sickDayBenefitEnabled !== undefined,
    { message: "At least one field must be provided" }
  );

export type ValidatedPatchOrganizationType = z.infer<typeof validatePatchOrganization>;

// better-auth user ids are opaque non-UUID strings.
export const validatePostOrganizationAdmin = z.object({
  userId: z.string().min(1),
});

export type ValidatedPostOrganizationAdminType = z.infer<typeof validatePostOrganizationAdmin>;

export type AttendanceSettingsType = {
  organizationId: string;
  attendanceEnabled: boolean;
  locationEnabled: boolean;
  timezone: string | null;
  holidayCountry: string | null;
  workingDays: number[];
  breakMinutes: number;
  breakThresholdMinutes: number;
  requiredMinutesPerDay: number;
  balanceMode: balanceMode;
  sessionCeilingMinutes: number;
  breakCeilingMinutes: number;
};

export type AttendanceSettingsValues = Omit<AttendanceSettingsType, "organizationId">;

// `Intl` is the only IANA list Node ships, and it is the same one the browser
// picker offers — a zone it rejects is one no `businessDate` could be computed in.
const isIanaTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * Full replacement, so every rule carries its default: a body naming only
 * `attendanceEnabled` writes the documented defaults rather than nulls, and a
 * client predating a field cannot leave it unset.
 */
export const validatePutAttendanceSettings = z
  .object({
    attendanceEnabled: z.boolean(),
    locationEnabled: z.boolean().default(ATTENDANCE_SETTINGS_DEFAULTS.locationEnabled),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isIanaTimezone, { message: "Unknown IANA timezone" })
      .nullable()
      .default(null),
    // Validated against the holiday dataset like a group's, not just the alpha-2
    // shape: a code we cannot compute holidays for would exclude no days at all.
    holidayCountry: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .refine(isSupportedCountry, { message: "Unsupported country code" })
      .nullable()
      .default(null),
    workingDays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .transform((days) => Array.from(new Set(days)).sort((a, b) => a - b))
      .default(ATTENDANCE_SETTINGS_DEFAULTS.workingDays),
    breakMinutes: z
      .number()
      .int()
      .min(0)
      .max(480)
      .default(ATTENDANCE_SETTINGS_DEFAULTS.breakMinutes),
    breakThresholdMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(ATTENDANCE_SETTINGS_DEFAULTS.breakThresholdMinutes),
    requiredMinutesPerDay: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(ATTENDANCE_SETTINGS_DEFAULTS.requiredMinutesPerDay),
    balanceMode: z.enum(balanceMode).default(ATTENDANCE_SETTINGS_DEFAULTS.balanceMode),
    sessionCeilingMinutes: z
      .number()
      .int()
      .min(60)
      .max(1440)
      .default(ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes),
    breakCeilingMinutes: z
      .number()
      .int()
      .min(15)
      .max(1440)
      .default(ATTENDANCE_SETTINGS_DEFAULTS.breakCeilingMinutes),
  })
  // The timezone fixes the business date, so switching attendance on without
  // one would pick a day boundary nobody chose.
  .refine((body) => !body.attendanceEnabled || body.timezone !== null, {
    path: ["timezone"],
    message: "A timezone is required to turn attendance on",
  });

export type ValidatedPutAttendanceSettingsType = z.infer<typeof validatePutAttendanceSettings>;
