export type GroupUser = {
  id: string;
  groupId: string;
  userId: string;
  confirmEmail: Date | null;
  viewAccess: boolean;
  adminAccess: boolean;
  controlledUser: boolean;
  deleted: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
