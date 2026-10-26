import { Cron } from "croner";
import type { DbTransaction } from "../../db/db.js";
import { config } from "../../config.js";
import { directoryRetentionPeriods } from "../../db/schema/directory-retention-schema.js";
import { refuse } from "../../utils/appError.js";
import { canReadPermissionTable, type DirectoryViewer } from "./directoryViewer.js";
import { canEditGeneralSettings } from "./emergencyContactNotice.js";
import { countDueUnder, readRetentionPeriods } from "./retentionPurge.js";
import { RETENTION_DEFAULTS } from "./retentionPeriods.js";
import type { PutRetentionPeriod, RetentionPreview, RetentionSettings } from "./types.js";

const contextOf = (viewer: DirectoryViewer) => ({
  organizationId: viewer.organizationId,
  viewerUserId: viewer.standing.userId,
});

const requireEditor = (viewer: DirectoryViewer) => {
  if (!canEditGeneralSettings(viewer)) {
    throw refuse(
      403,
      "SETTINGS_NOT_EDITABLE",
      "Only the owner and org admins change these",
      contextOf(viewer)
    );
  }
};

/** When the nightly tick runs next, which is when a shortened period takes effect. */
export const nextNightlyRun = (now = new Date()): Date =>
  new Cron(config.quotaRollover.cron, {
    timezone: config.quotaRollover.timezone,
    paused: true,
  }).nextRun(now) ?? now;

/** The owner, org admins and HR read the Retention periods. */
export const readRetentionSettings = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<RetentionSettings> => {
  if (!canReadPermissionTable(viewer)) {
    throw refuse(
      403,
      "SETTINGS_DENIED",
      "Only the owner, org admins and HR open Directory settings",
      contextOf(viewer)
    );
  }
  return {
    editable: canEditGeneralSettings(viewer),
    periods: await readRetentionPeriods(viewer.organizationId, tx),
    defaults: { ...RETENTION_DEFAULTS },
  };
};

/**
 * Sets one Section's Retention period. The owner and org admins only, on
 * every plan. It rewrites nothing else: the next nightly run reads it.
 */
export const updateRetentionPeriod = async (
  viewer: DirectoryViewer,
  body: PutRetentionPeriod,
  tx: DbTransaction
): Promise<RetentionSettings> => {
  requireEditor(viewer);
  await tx
    .insert(directoryRetentionPeriods)
    .values({
      organizationId: viewer.organizationId,
      section: body.section,
      period: body.period,
      changedByUserId: viewer.standing.userId,
    })
    .onConflictDoUpdate({
      target: [directoryRetentionPeriods.organizationId, directoryRetentionPeriods.section],
      set: { period: body.period, changedByUserId: viewer.standing.userId, updatedAt: new Date() },
    });
  return readRetentionSettings(viewer, tx);
};

/** How many people a period would remove at the next nightly run, for the shortening dialog. */
export const previewRetentionPeriod = async (
  viewer: DirectoryViewer,
  query: PutRetentionPeriod,
  now = new Date()
): Promise<RetentionPreview> => {
  requireEditor(viewer);
  const affected = await countDueUnder({
    organizationId: viewer.organizationId,
    section: query.section,
    period: query.period,
    at: nextNightlyRun(now),
  });
  return { ...query, affected };
};
