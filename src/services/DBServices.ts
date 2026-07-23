import * as vacationServices from "./vacation/vacationServices.js";
import * as vacationEventServices from "./vacationEvent/vacationEventServices.js";
import * as groupUserServices from "./groupUser/groupUserServices.js";
import * as groupServices from "./group/groupServices.js";
import * as userYearQuotasServices from "./userYearQuotas/userYearQuotasServices.js";
import * as changesServices from "./changes/changesServices.js";
import * as userSettingsServices from "./userSettings/userSettingsServices.js";
import * as bankHolidayServices from "./bankHoliday/bankHolidayServices.js";
import * as notificationServices from "./notification/notificationServices.js";
import * as calendarSyncServices from "./calendarSync/calendarSyncServices.js";

export type DBServices = Readonly<{
  vacation: {
    getVacationById: typeof vacationServices.getVacationById;
    getVacationDetailById: typeof vacationServices.getVacationDetailById;
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
  vacationEvent: {
    createVacationEvent: typeof vacationEventServices.createVacationEvent;
    createVacationEvents: typeof vacationEventServices.createVacationEvents;
    getVacationEvents: typeof vacationEventServices.getVacationEvents;
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
    upsertUserYearQuota: typeof userYearQuotasServices.upsertUserYearQuota;
    sumUserQuotasForYear: typeof userYearQuotasServices.sumUserQuotasForYear;
  };
  changes: {
    getChanges: typeof changesServices.getChangesForUser;
    postChanges: typeof changesServices.postChanges;
  };
  userSettings: {
    getUserSettings: typeof userSettingsServices.getUserSettings;
    upsertUserSettings: typeof userSettingsServices.upsertUserSettings;
    filterUsersAcceptingEmail: typeof userSettingsServices.filterUsersAcceptingEmail;
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
  calendarSync: {
    generateFeedToken: typeof calendarSyncServices.generateFeedToken;
    createCalendarSync: typeof calendarSyncServices.createCalendarSync;
    getCalendarSyncForUser: typeof calendarSyncServices.getCalendarSyncForUser;
    getCalendarSyncById: typeof calendarSyncServices.getCalendarSyncById;
    getCalendarSyncByToken: typeof calendarSyncServices.getCalendarSyncByToken;
    updateCalendarSync: typeof calendarSyncServices.updateCalendarSync;
    softDeleteCalendarSync: typeof calendarSyncServices.softDeleteCalendarSync;
    regenerateToken: typeof calendarSyncServices.regenerateToken;
    touchLastFetched: typeof calendarSyncServices.touchLastFetched;
    getFeedRecords: typeof calendarSyncServices.getFeedRecords;
  };
}>;

export const createDBServices = (): DBServices => {
  return {
    vacation: {
      getVacationById: vacationServices.getVacationById,
      getVacationDetailById: vacationServices.getVacationDetailById,
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
      getPendingApprovalsForApprover: vacationServices.getPendingApprovalsForApprover,
      countUsersOutOnDay: vacationServices.countUsersOutOnDay,
      countApprovedVacationsInRange: vacationServices.countApprovedVacationsInRange,
      aggregateUserUsageForYear: vacationServices.aggregateUserUsageForYear,
    },
    vacationEvent: {
      createVacationEvent: vacationEventServices.createVacationEvent,
      createVacationEvents: vacationEventServices.createVacationEvents,
      getVacationEvents: vacationEventServices.getVacationEvents,
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
      decreaseChangeForUserYearQuotas: userYearQuotasServices.decreaseChangeForUserYearQuotas,
      updateUserYearQuotasById: userYearQuotasServices.updateUserYearQuotasById,
      upsertUserYearQuota: userYearQuotasServices.upsertUserYearQuota,
      sumUserQuotasForYear: userYearQuotasServices.sumUserQuotasForYear,
    },
    changes: {
      getChanges: changesServices.getChangesForUser,
      postChanges: changesServices.postChanges,
    },
    userSettings: {
      getUserSettings: userSettingsServices.getUserSettings,
      upsertUserSettings: userSettingsServices.upsertUserSettings,
      filterUsersAcceptingEmail: userSettingsServices.filterUsersAcceptingEmail,
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
    calendarSync: {
      generateFeedToken: calendarSyncServices.generateFeedToken,
      createCalendarSync: calendarSyncServices.createCalendarSync,
      getCalendarSyncForUser: calendarSyncServices.getCalendarSyncForUser,
      getCalendarSyncById: calendarSyncServices.getCalendarSyncById,
      getCalendarSyncByToken: calendarSyncServices.getCalendarSyncByToken,
      updateCalendarSync: calendarSyncServices.updateCalendarSync,
      softDeleteCalendarSync: calendarSyncServices.softDeleteCalendarSync,
      regenerateToken: calendarSyncServices.regenerateToken,
      touchLastFetched: calendarSyncServices.touchLastFetched,
      getFeedRecords: calendarSyncServices.getFeedRecords,
    },
  };
};
