import type { DbTransaction } from "../../db/db.js";
import {
  directoryProfileHistory,
  profileHistoryActor,
} from "../../db/schema/directory-profile-schema.js";
import type {
  directoryAudience,
  directoryPermissionRow,
} from "../../db/schema/directory-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";

export type ProfileHistoryInput = {
  organizationId: string;
  employmentId: string;
  section: directoryPermissionRow;
  fields: readonly string[];
} & ({ actorUserId: string | null; audience: directoryAudience } | { retention: true });

/**
 * Appends Profile history rows: which fields of which Section changed, by a
 * person through the Audience that let them, or by a Retention purge. Never a
 * value.
 */
export const recordProfileHistory = async (
  entries: ProfileHistoryInput[],
  tx: DbTransaction
): Promise<void> => {
  if (entries.length === 0) return;
  await tx.insert(directoryProfileHistory).values(
    entries.map((entry) => ({
      id: generateRandomUUID(),
      organizationId: entry.organizationId,
      employmentId: entry.employmentId,
      section: entry.section,
      fields: [...entry.fields],
      ...("retention" in entry
        ? { actor: profileHistoryActor.Retention, actorUserId: null, audience: null }
        : {
            actor: profileHistoryActor.Person,
            actorUserId: entry.actorUserId,
            audience: entry.audience,
          }),
    }))
  );
};
