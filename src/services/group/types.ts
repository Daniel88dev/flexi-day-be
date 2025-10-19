export type GroupType = {
  id: string;
  groupName: string;
  defaultVacationDays: number;
  defaultHomeOfficeDays: number;
  managerUserId: string;
  mainApprovalUser: string | null;
  tempApprovalUser: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupInsertType = {
  id: string;
  groupName: string;
  managerUserId: string;
  defaultVacationDays?: number;
  defaultHomeOfficeDays?: number;
  mainApprovalUser?: string;
};
