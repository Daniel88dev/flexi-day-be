export type GroupUser = {
  id: string;
  groupId: string;
  userId: string;
  emailConfirmedAt: Date | null;
  viewAccess: boolean;
  adminAccess: boolean;
  controlledUser: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
