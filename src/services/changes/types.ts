import type { changesType } from "../../db/schema/changes-schema.js";

export type ChangeRecordType = {
  id: string;
  userId: string;
  groupId: string;
  changeType: changesType;
  changeDetail: string;
  changingUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ChangeInsertType = Pick<
  ChangeRecordType,
  "id" | "userId" | "groupId" | "changeType" | "changingUserId" | "changeDetail"
>;
