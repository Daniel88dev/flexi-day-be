import { auth } from "../utils/auth.js";
import { logger } from "../middleware/logger.js";
import { checkAuthSecret } from "../services/authSecret/authSecretServices.js";
import { reencryptToCurrentVersion } from "../services/authSecret/reencryptServices.js";

/**
 * Runs once per boot. A failure only logs: no cookie signed with an old secret
 * verifies anyway, a row left under the previous version still decrypts, and
 * the next boot tries both again.
 */
export const runAuthSecretCheck = async (): Promise<void> => {
  const { secret, secretConfig } = await auth.$context;

  try {
    const result = await checkAuthSecret(secret);

    if (result.outcome === "rotated") {
      logger.warn("auth.secret_rotated", { sessionsDeleted: result.sessionsDeleted });
    } else {
      logger.debug("Auth secret check", { outcome: result.outcome });
    }
  } catch (error) {
    logger.error("auth.secret_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // A plain string means no versions are configured, which only a unit test runs with.
  if (typeof secretConfig === "string") return;

  try {
    const { reencrypted, unreadable } = await reencryptToCurrentVersion(secretConfig);
    if (reencrypted > 0) {
      logger.info("auth.secret_reencrypted", {
        version: secretConfig.currentVersion,
        rows: reencrypted,
      });
    }
    if (Object.keys(unreadable).length > 0) {
      logger.error("auth.secret_unreadable_rows", { unreadable });
    }
  } catch (error) {
    logger.error("auth.secret_reencrypt_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
