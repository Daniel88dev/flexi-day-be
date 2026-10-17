import { auth } from "../utils/auth.js";
import { logger } from "../middleware/logger.js";
import { checkAuthSecret } from "../services/authSecret/authSecretServices.js";

/**
 * Runs once per boot. A failure only logs: no cookie signed with an old secret
 * verifies anyway, and the next boot tries again.
 */
export const runAuthSecretCheck = async (): Promise<void> => {
  try {
    const { secret } = await auth.$context;
    const result = await checkAuthSecret(secret);

    if (result.outcome === "rotated") {
      logger.warn("auth.secret_rotated", { sessionsDeleted: result.sessionsDeleted });
      return;
    }
    logger.debug("Auth secret check", { outcome: result.outcome });
  } catch (error) {
    logger.error("auth.secret_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
