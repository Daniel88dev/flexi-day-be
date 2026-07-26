import { Cron } from "croner";
import { config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { rolloverQuotasForYear } from "../services/quotaRollover/quotaRolloverServices.js";

let job: Cron | null = null;

/**
 * Opens the current year's allowances for anyone still missing them. Safe to
 * call at any time — the underlying service only creates rows that are absent.
 */
export const runQuotaRollover = async (year = new Date().getFullYear()): Promise<void> => {
  const startedAt = Date.now();
  try {
    const result = await rolloverQuotasForYear(year);

    if (result.skipped) return;
    if (result.created === 0) {
      logger.debug("Quota rollover: nothing to open", { year });
      return;
    }

    logger.info("Quota rollover created new allowances", {
      year,
      created: result.created,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // Never rethrow: an unhandled rejection inside a timer callback would take
    // the process down, and a failed rollover is recoverable on the next tick.
    logger.error("Quota rollover failed", {
      year,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Schedules the rollover. Runs once at startup as well as on the cron, so a
 * deployment that happens to land after a missed trigger catches up
 * immediately rather than waiting for the next window.
 */
export const startQuotaRolloverJob = (): Cron | null => {
  if (!config.quotaRollover.enabled) {
    logger.info("Quota rollover job disabled");
    return null;
  }

  if (job) return job;

  job = new Cron(
    config.quotaRollover.cron,
    {
      timezone: config.quotaRollover.timezone,
      // A run that overruns its window must not overlap the next one — both
      // would contend on the same advisory lock for nothing.
      protect: true,
      name: "quota-rollover",
    },
    () => runQuotaRollover()
  );

  logger.info("Quota rollover job scheduled", {
    cron: config.quotaRollover.cron,
    timezone: config.quotaRollover.timezone,
    nextRun: job.nextRun()?.toISOString(),
  });

  void runQuotaRollover();

  return job;
};

export const stopQuotaRolloverJob = (): void => {
  job?.stop();
  job = null;
};
