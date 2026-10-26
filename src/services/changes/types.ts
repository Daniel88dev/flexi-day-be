import type { changesType } from "../../db/schema/changes-schema.js";

export type ChangeRecordType = {
  id: string;
  userId: string;
  groupId: string;
  changeType: changesType;
  changeDetail: string;
  /** Null when the quota rollover wrote the row, or when `changingUserDeleted` is set. */
  changingUserId: string | null;
  /** The actor was cleared by an account deletion made before Deleted accounts kept their row. */
  changingUserDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ChangeInsertType = Pick<
  ChangeRecordType,
  "id" | "userId" | "groupId" | "changeType" | "changingUserId" | "changeDetail"
>;
