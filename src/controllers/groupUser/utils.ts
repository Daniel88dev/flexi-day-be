import { getGroupUser } from "../../services/groupUser/groupUserServices.js";
import AppError from "../../utils/appError.js";

export const validateUserGroupAccess = async (
  userId: string,
  groupId: string
): Promise<boolean> => {
  const groupUser = await getGroupUser(userId, groupId);
  return groupUser?.viewAccess ?? false;
};

/** Throws 403 unless the caller's membership carries `adminAccess`. */
export const assertGroupAdmin = async (userId: string, groupId: string): Promise<void> => {
  const groupUser = await getGroupUser(userId, groupId);
  if (!groupUser?.adminAccess) {
    throw new AppError({
      message: "No permission for related group",
      logging: true,
      code: 403,
      context: { userId, groupId },
    });
  }
};
