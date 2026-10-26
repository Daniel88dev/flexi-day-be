import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../db/db.js";
import { personExports, personExportStatus } from "../../db/schema/person-export-schema.js";
import { logger } from "../../middleware/logger.js";
import { attachmentStore } from "../attachment/attachmentStore.js";
import {
  organizationDataStore,
  type OrganizationDataStore,
} from "../organizationData/organizationDataStore.js";
import { writePersonExportZip } from "./personExportArchive.js";
import { collectPersonExport } from "./personExportData.js";
import { notifyExportReady } from "./personExportNotifier.js";
import { EXPORT_FILE_TTL_MS, ZIP_CONTENT_TYPE } from "./types.js";

export type ExportBuildOutcome =
  { status: "done" } | { status: "busy" } | { status: "retry"; attempts: number };

/** Attempts before a row is marked `FAILED`; the queue's retry delays cover the ones in between. */
export const MAX_BUILD_ATTEMPTS = 4;

export const exportStorageKey = (organizationId: string, exportId: string) =>
  `exports/${organizationId}/${exportId}.zip`;

const lockKey = (exportId: string) => `person-export:${exportId}`;

type BuildDependencies = {
  store?: OrganizationDataStore;
  readAttachment?: (storageKey: string) => Promise<Buffer | undefined>;
};

/**
 * Builds one `PENDING` export into its ZIP and marks it `READY`. A session
 * advisory lock on a connection held for the whole build is what says "being
 * built": a second instance gets `busy`, and a process that dies mid-build
 * drops the connection and with it the lock, so the row is picked up again.
 */
export const buildPersonExport = async (
  exportId: string,
  dependencies: BuildDependencies = {}
): Promise<ExportBuildOutcome> => {
  const store = dependencies.store ?? organizationDataStore;
  const readAttachment =
    dependencies.readAttachment ?? ((key: string) => attachmentStore.getObject(key));

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [lockKey(exportId)]
    );
    if (!lock.rows[0]?.locked) return { status: "busy" };
    locked = true;

    const [claimed] = await db
      .update(personExports)
      .set({ attempts: sql`${personExports.attempts} + 1` })
      .where(
        and(eq(personExports.id, exportId), eq(personExports.status, personExportStatus.Pending))
      )
      .returning();
    if (!claimed) return { status: "done" };

    const directory = await mkdtemp(path.join(os.tmpdir(), "person-export-"));
    try {
      if (!store) throw new Error("No organization data store is configured");
      const content = await collectPersonExport(claimed.organizationId, claimed.subjectUserId);
      const file = path.join(directory, "export.zip");
      await writePersonExportZip(file, content, readAttachment);
      const key = exportStorageKey(claimed.organizationId, claimed.id);
      await store.putFile(key, file, ZIP_CONTENT_TYPE);
      const { size } = await stat(file);

      const readyAt = new Date();
      const [ready] = await db
        .update(personExports)
        .set({
          status: personExportStatus.Ready,
          storageKey: key,
          sizeBytes: size,
          readyAt,
          expiresAt: new Date(readyAt.getTime() + EXPORT_FILE_TTL_MS),
        })
        .where(
          and(eq(personExports.id, exportId), eq(personExports.status, personExportStatus.Pending))
        )
        .returning();
      if (ready) await notifyExportReady(ready);
      logger.info("person_export.ready", { exportId, attempts: claimed.attempts, size });
      return { status: "done" };
    } catch (error) {
      logger.error("person_export.build_failed", {
        exportId,
        attempts: claimed.attempts,
        error,
      });
      if (claimed.attempts >= MAX_BUILD_ATTEMPTS) {
        await db
          .update(personExports)
          .set({ status: personExportStatus.Failed, failedAt: new Date() })
          .where(eq(personExports.id, exportId));
        return { status: "done" };
      }
      return { status: "retry", attempts: claimed.attempts };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    if (locked) {
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey(exportId)])
        .catch(() => undefined);
    }
    client.release();
  }
};

/** Every row still waiting for its ZIP, oldest first: what a restart resumes. */
export const getPendingExportIds = async (): Promise<string[]> => {
  const rows = await db
    .select({ id: personExports.id })
    .from(personExports)
    .where(eq(personExports.status, personExportStatus.Pending))
    .orderBy(personExports.createdAt);
  return rows.map((row) => row.id);
};
