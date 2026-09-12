import type { Request } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import type {
  AttendanceSettingsType,
  OrganizationType,
} from "../../services/organization/types.js";
import {
  getAdminOrganizationsForUser,
  getOrganizationById,
  isOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

/**
 * The organization to act on when the request names none: the caller's own.
 * A delegated admin who owns nothing gets a default only when they administer
 * exactly one — with several there is no sensible pick, and silently taking
 * the oldest would let an unqualified `PATCH` rename the wrong organization.
 */
const resolveDefaultOrganization = async (userId: string) => {
  const administered = await getAdminOrganizationsForUser(userId);
  const owned = administered.find((organization) => organization.ownerUserId === userId);
  if (owned) return owned;

  if (administered.length > 1) {
    throw new AppError({
      message: "Name the organization to act on",
      logging: true,
      code: 400,
      context: { userId, administered: administered.length },
    });
  }

  return administered[0];
};

/**
 * Resolves the organization the request is about and checks the caller
 * administers it. `organizationId` may be omitted, in which case the caller's
 * own organization is used — most people have exactly one.
 */
export const resolveAdministeredOrganization = async (
  req: Request
): Promise<{ organization: OrganizationType; isOwner: boolean }> => {
  const auth = getAuth(req);

  const organizationId = z.string().min(1).optional().parse(req.query.organizationId);

  const organization = organizationId
    ? await getOrganizationById(organizationId)
    : await resolveDefaultOrganization(auth.userId);

  if (!organization) {
    throw new AppError({
      message: "Organization not found",
      logging: true,
      code: 404,
      context: { userId: auth.userId, organizationId },
    });
  }

  const isAdmin = await isOrganizationAdmin(auth.userId, organization.id);
  if (!isAdmin) {
    throw new AppError({
      message: "No permission for related organization",
      logging: true,
      code: 403,
      context: { userId: auth.userId, organizationId: organization.id },
    });
  }

  return { organization, isOwner: organization.ownerUserId === auth.userId };
};

/** Throws 403 unless the caller owns the organization — billing-adjacent writes are owner-only. */
export const assertOrganizationOwner = (organization: OrganizationType, userId: string): void => {
  if (organization.ownerUserId !== userId) {
    throw new AppError({
      message: "Only the organization owner can perform this action",
      logging: true,
      code: 403,
      context: { userId, organizationId: organization.id },
    });
  }
};

/**
 * The wire shape of the attendance settings, shared by the get and the put so
 * a save answers exactly what a re-read would.
 */
export const presentAttendanceSettings = (settings: AttendanceSettingsType, active: boolean) => ({
  organizationId: settings.organizationId,
  attendanceEnabled: settings.attendanceEnabled,
  locationEnabled: settings.locationEnabled,
  timezone: settings.timezone,
  holidayCountry: settings.holidayCountry,
  workingDays: settings.workingDays,
  breakMinutes: settings.breakMinutes,
  breakThresholdMinutes: settings.breakThresholdMinutes,
  requiredMinutesPerDay: settings.requiredMinutesPerDay,
  balanceMode: settings.balanceMode,
  sessionCeilingMinutes: settings.sessionCeilingMinutes,
  breakCeilingMinutes: settings.breakCeilingMinutes,
  /** The toggle alone does not make attendance usable; this is the live answer. */
  active,
});
