import * as vacationServices from "./vacation/vacationServices.js";
import * as groupUserServices from "./groupUser/groupUserServices.js";
import * as groupServices from "./group/groupServices.js";
import * as userYearQuotasServices from "./userYearQuotas/userYearQuotasServices.js";
import * as changesServices from "./changes/changesServices.js";
import * as bankHolidayServices from "./bankHoliday/bankHolidayServices.js";
import * as notificationServices from "./notification/notificationServices.js";

export type DBServices = Readonly<{
  vacation: {
    getVacationById: typeof vacationServices.getVacationById;
    getVacationsForGroup: typeof vacationServices.getVacationsForGroup;
    getVacationsForUser: typeof vacationServices.getVacationsForUser;
    postVacation: typeof vacationServices.postVacation;
    postVacationBulk: typeof vacationServices.postVacationBulk;
    approveVacation: typeof vacationServices.approveVacation;
    rejectVacation: typeof vacationServices.rejectVacation;
    approveVacationsBulk: typeof vacationServices.approveVacationsBulk;
    rejectVacationsBulk: typeof vacationServices.rejectVacationsBulk;
    getVacationsByIds: typeof vacationServices.getVacationsByIds;
    deleteVacation: typeof vacationServices.deleteVacation;
    getPendingApprovalsForApprover: typeof vacationServices.getPendingApprovalsForApprover;
    countUsersOutOnDay: typeof vacationServices.countUsersOutOnDay;
    countApprovedVacationsInRange: typeof vacationServices.countApprovedVacationsInRange;
    aggregateUserUsageForYear: typeof vacationServices.aggregateUserUsageForYear;
  };
  groupUser: {
    getGroupUser: typeof groupUserServices.getGroupUser;
    getGroupUsers: typeof groupUserServices.getGroupUsers;
    createGroupUser: typeof groupUserServices.createGroupUser;
    updateGroupUserPermissions: typeof groupUserServices.updateGroupUserPermissions;
    deleteGroupUser: typeof groupUserServices.deleteGroupUser;
    getAllGroupsForUser: typeof groupUserServices.getAllGroupsForUser;
    countDistinctUsersInGroups: typeof groupUserServices.countDistinctUsersInGroups;
  };
  inviteLinks: {
    createInviteLink: typeof groupUserServices.createInviteLink;
    getInviteLinksForGroup: typeof groupUserServices.getInviteLinksForGroup;
    getInviteLinkByCode: typeof groupUserServices.getInviteLinkByCode;
    useInviteLink: typeof groupUserServices.useInviteLink;
  };
  group: {
    getGroup: typeof groupServices.getGroup;
    getAllGroups: typeof groupServices.getAllGroups;
    createGroup: typeof groupServices.createGroup;
    updateGroupManager: typeof groupServices.updateGroupManager;
    updateGroupApprovalUsers: typeof groupServices.updateGroupApprovalUsers;
    deleteGroup: typeof groupServices.deleteGroup;
    updateGroupQuotas: typeof groupServices.updateGroupQuotas;
    getApprovalUsers: typeof groupServices.getApprovalUsers;
    getGroupsWhereUserCanApprove: typeof groupServices.getGroupsWhereUserCanApprove;
  };
  userYearQuotas: {
    getUserYearGroupQuotas: typeof userYearQuotasServices.getUserYearGroupQuotas;
    insertUserYearQuotas: typeof userYearQuotasServices.insertUserYearQuotas;
    decreaseChangeForUserYearQuotas: typeof userYearQuotasServices.decreaseChangeForUserYearQuotas;
    updateUserYearQuotasById: typeof userYearQuotasServices.updateUserYearQuotasById;
    sumUserQuotasForYear: typeof userYearQuotasServices.sumUserQuotasForYear;
  };
  changes: {
    getChanges: typeof changesServices.getChangesForUser;
    postChanges: typeof changesServices.postChanges;
  };
  bankHoliday: {
    listBankHolidays: typeof bankHolidayServices.listBankHolidays;
  };
  notification: {
    listNotificationsForUser: typeof notificationServices.listNotificationsForUser;
    markNotificationRead: typeof notificationServices.markNotificationRead;
    getNotificationForUser: typeof notificationServices.getNotificationForUser;
    createNotification: typeof notificationServices.createNotification;
  };
}>;

export const createDBServices = (): DBServices => {
  return {
    vacation: {
      getVacationById: vacationServices.getVacationById,
      getVacationsForGroup: vacationServices.getVacationsForGroup,
      getVacationsForUser: vacationServices.getVacationsForUser,
      postVacation: vacationServices.postVacation,
      postVacationBulk: vacationServices.postVacationBulk,
      approveVacation: vacationServices.approveVacation,
      rejectVacation: vacationServices.rejectVacation,
      approveVacationsBulk: vacationServices.approveVacationsBulk,
      rejectVacationsBulk: vacationServices.rejectVacationsBulk,
      getVacationsByIds: vacationServices.getVacationsByIds,
      deleteVacation: vacationServices.deleteVacation,
      getPendingApprovalsForApprover:
        vacationServices.getPendingApprovalsForApprover,
      countUsersOutOnDay: vacationServices.countUsersOutOnDay,
      countApprovedVacationsInRange:
        vacationServices.countApprovedVacationsInRange,
      aggregateUserUsageForYear: vacationServices.aggregateUserUsageForYear,
    },
    groupUser: {
      getGroupUser: groupUserServices.getGroupUser,
      getGroupUsers: groupUserServices.getGroupUsers,
      createGroupUser: groupUserServices.createGroupUser,
      updateGroupUserPermissions: groupUserServices.updateGroupUserPermissions,
      deleteGroupUser: groupUserServices.deleteGroupUser,
      getAllGroupsForUser: groupUserServices.getAllGroupsForUser,
      countDistinctUsersInGroups: groupUserServices.countDistinctUsersInGroups,
    },
    inviteLinks: {
      createInviteLink: groupUserServices.createInviteLink,
      getInviteLinksForGroup: groupUserServices.getInviteLinksForGroup,
      getInviteLinkByCode: groupUserServices.getInviteLinkByCode,
      useInviteLink: groupUserServices.useInviteLink,
    },
    group: {
      getGroup: groupServices.getGroup,
      getAllGroups: groupServices.getAllGroups,
      createGroup: groupServices.createGroup,
      updateGroupManager: groupServices.updateGroupManager,
      updateGroupApprovalUsers: groupServices.updateGroupApprovalUsers,
      deleteGroup: groupServices.deleteGroup,
      updateGroupQuotas: groupServices.updateGroupQuotas,
      getApprovalUsers: groupServices.getApprovalUsers,
      getGroupsWhereUserCanApprove: groupServices.getGroupsWhereUserCanApprove,
    },
    userYearQuotas: {
      getUserYearGroupQuotas: userYearQuotasServices.getUserYearGroupQuotas,
      insertUserYearQuotas: userYearQuotasServices.insertUserYearQuotas,
      decreaseChangeForUserYearQuotas:
        userYearQuotasServices.decreaseChangeForUserYearQuotas,
      updateUserYearQuotasById: userYearQuotasServices.updateUserYearQuotasById,
      sumUserQuotasForYear: userYearQuotasServices.sumUserQuotasForYear,
    },
    changes: {
      getChanges: changesServices.getChangesForUser,
      postChanges: changesServices.postChanges,
    },
    bankHoliday: {
      listBankHolidays: bankHolidayServices.listBankHolidays,
    },
    notification: {
      listNotificationsForUser: notificationServices.listNotificationsForUser,
      markNotificationRead: notificationServices.markNotificationRead,
      getNotificationForUser: notificationServices.getNotificationForUser,
      createNotification: notificationServices.createNotification,
    },
  };
};
