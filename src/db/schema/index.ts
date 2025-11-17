import { account, session, user, verification } from "./auth-schema.js";
import { groupUsers } from "./group-users-schema.js";
import { groups } from "./group-schema.js";
import { userYearQuotas } from "./user-year-quotas-schema.js";
import { vacation } from "./vacation-schema.js";
import { inviteLink } from "./invite-link-schema.js";

export const schema = {
  account,
  session,
  user,
  verification,
  groupUsers,
  groups,
  userYearQuotas,
  vacation,
  inviteLink,
};
