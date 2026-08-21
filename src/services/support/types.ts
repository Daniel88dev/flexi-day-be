import type { Entitlements } from "../billing/entitlements.js";
import type { OrganizationAdminListItem } from "../organization/types.js";

export type SupportOrganizationListItem = {
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  ownerEmail: string;
  liveGroups: number;
  /** Resolved entitlement plan — "FREE" when there is no subscription row. */
  plan: string;
  status: string | null;
  createdAt: Date;
};

export type SupportGroupListItem = {
  id: string;
  groupName: string;
  managerUserId: string;
  members: number;
  deletedAt: Date | null;
  createdAt: Date;
};

export type SupportOrganizationDetail = {
  organization: {
    id: string;
    name: string;
    billingEmail: string;
    paddleCustomerId: string | null;
    createdAt: Date;
  };
  owner: { userId: string; name: string; email: string };
  plan: Entitlements & { status: string | null };
  groups: SupportGroupListItem[];
  admins: OrganizationAdminListItem[];
};

export type SupportGroupMember = {
  userId: string;
  name: string;
  email: string;
  viewAccess: boolean;
  adminAccess: boolean;
  approverAccess: boolean;
  controlledUser: boolean;
  deletedAt: Date | null;
};

export type SupportQuotaRow = {
  userId: string;
  relatedYear: string;
  vacationDays: number;
  homeOfficeDays: number;
  carriedOverDays: number;
};

/**
 * Deliberately without `note` and `rejectionReason`: they can carry personal
 * detail ("medical appointment") that debugging a state bug never needs.
 */
export type SupportVacationRow = {
  id: string;
  userId: string;
  userName: string;
  requestedDay: string;
  vacationType: string;
  halfDay: boolean;
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
};

export type SupportGroupDetail = {
  group: {
    id: string;
    groupName: string;
    organizationId: string;
    organizationName: string;
    managerUserId: string;
    mainApprovalUser: string | null;
    tempApprovalUser: string | null;
    defaultVacationDays: number;
    defaultHomeOfficeDays: number;
    workingDays: number[];
    holidayCountry: string | null;
    deletedAt: Date | null;
    createdAt: Date;
  };
  members: SupportGroupMember[];
  quotas: SupportQuotaRow[];
  vacations: SupportVacationRow[];
};
