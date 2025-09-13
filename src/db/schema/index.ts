import { account, session, user, verification } from "./auth-schema.js";
import { groupUsers } from "./group-users-schema.js";
import { group } from "./group-schema.js";
import { userYearQuotas } from "./user-year-quotas-schema.js";
import { vacation } from "./vacation-schema.js";

export const schema = {
  account,
  session,
  user,
  verification,
  companyUsers: groupUsers,
  group,
  userYearQuotas,
  vacation,
};
