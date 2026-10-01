import type { changesType } from "../../db/schema/changes-schema.js";

export type ChangeRecordType = {
  id: string;
  userId: string;
  groupId: string;
  changeType: changesType;
  changeDetail: string;
  /** Null when the quota rollover wrote the row, or when `changingUserDeleted` is set. */
  changingUserId: string | null;
  /** The person who made the change has since deleted their account. */
  changingUserDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ChangeInsertType = Pick<
  ChangeRecordType,
  "id" | "userId" | "groupId" | "changeType" | "changingUserId" | "changeDetail"
>;
