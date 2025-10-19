export type GroupUser = {
  id: string;
  groupId: string;
  userId: string;
  viewAccess: boolean;
  adminAccess: boolean;
  controlledUser: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupUserInsertType = {
  id: string;
  groupId: string;
  userId: string;
  viewAccess?: boolean;
  adminAccess?: boolean;
  controlledUser?: boolean;
};

export type GroupUserPermissions = Pick<
  GroupUser,
  "viewAccess" | "adminAccess" | "controlledUser"
>;
