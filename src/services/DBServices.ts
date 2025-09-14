import * as vacationServices from "./vacation/vacationServices.js";
import * as groupUserServices from "./groupUser/groupUserServices.js";
import * as groupServices from "./group/groupServices.js";

export type DBServices = {
  vacation: {
    getVacations: typeof vacationServices.getVacations;
    postVacation: typeof vacationServices.postVacation;
    approveVacation: typeof vacationServices.approveVacation;
    rejectVacation: typeof vacationServices.rejectVacation;
    deleteVacation: typeof vacationServices.deleteVacation;
  };
  groupUser: {
    getGroupUser: typeof groupUserServices.getGroupUser;
    createGroupUser: typeof groupUserServices.createGroupUser;
    updateGroupUserPermissions: typeof groupUserServices.updateGroupUserPermissions;
    deleteGroupUser: typeof groupUserServices.deleteGroupUser;
    getAllGroupsForUser: typeof groupUserServices.getAllGroupsForUser;
  };
  group: {
    getGroup: typeof groupServices.getGroup;
    getAllGroups: typeof groupServices.getAllGroups;
    createGroup: typeof groupServices.createGroup;
    updateGroupManager: typeof groupServices.updateGroupManager;
    updateGroupApprovalUsers: typeof groupServices.updateGroupApprovalUsers;
    deleteGroup: typeof groupServices.deleteGroup;
    updateGroupQuotas: typeof groupServices.updateGroupQuotas;
  };
};

export const createDBServices = (): DBServices => {
  return {
    vacation: {
      getVacations: vacationServices.getVacations,
      postVacation: vacationServices.postVacation,
      approveVacation: vacationServices.approveVacation,
      rejectVacation: vacationServices.rejectVacation,
      deleteVacation: vacationServices.deleteVacation,
    },
    groupUser: {
      getGroupUser: groupUserServices.getGroupUser,
      createGroupUser: groupUserServices.createGroupUser,
      updateGroupUserPermissions: groupUserServices.updateGroupUserPermissions,
      deleteGroupUser: groupUserServices.deleteGroupUser,
      getAllGroupsForUser: groupUserServices.getAllGroupsForUser,
    },
    group: {
      getGroup: groupServices.getGroup,
      getAllGroups: groupServices.getAllGroups,
      createGroup: groupServices.createGroup,
      updateGroupManager: groupServices.updateGroupManager,
      updateGroupApprovalUsers: groupServices.updateGroupApprovalUsers,
      deleteGroup: groupServices.deleteGroup,
      updateGroupQuotas: groupServices.updateGroupQuotas,
    },
  };
};
