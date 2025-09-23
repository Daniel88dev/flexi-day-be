export type UserYearQuotasType = {
  id: string;
  userId: string;
  groupId: string;
  relatedYear: string;
  vacationDays: number;
  homeOfficeDays: number;
  createdAt: Date;
  updatedAt: Date;
};

export type UserYearQuotasInsertType = Pick<
  UserYearQuotasType,
  "id" | "userId" | "groupId" | "relatedYear" | "homeOfficeDays"
>;

export type UserYearQuotasUpdateType = {
  userId: string;
  groupId: string;
  relatedYear: string;
  vacationChange: number;
  homeOfficeChange: number;
};
