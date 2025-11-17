import { getGroupUser } from "../../services/groupUser/groupUserServices.js";

export const validateUserGroupAccess = async (
  userId: string,
  groupId: string
): Promise<boolean> => {
  const groupUser = await getGroupUser(userId, groupId);
  return groupUser?.viewAccess ?? false;
};
