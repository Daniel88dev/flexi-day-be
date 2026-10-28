import type { DbTransaction } from "../../db/db.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertDirectoryWritable } from "../billing/guards.js";
import {
  assertEmploymentEmailFree,
  findOpenEmploymentByEmail,
} from "../employment/accountlessClash.js";
import { assertAssignableEntry } from "./directoryListServices.js";
import { assertReportsTo } from "./directoryProfileEditServices.js";
import { getDirectoryProfile } from "./directoryProfileServices.js";
import { createPersonGrantor, type DirectoryViewer } from "./directoryViewer.js";
import { recordProfileHistory } from "./profileHistory.js";
import { CARD_COLUMNS } from "./profileSectionFields.js";
import type { DirectoryProfile, PostDirectoryPerson } from "./types.js";

const contextOf = (viewer: DirectoryViewer) => ({
  organizationId: viewer.organizationId,
  viewerUserId: viewer.standing.userId,
});

const assertCanCreate = (viewer: DirectoryViewer) => {
  const grantor = createPersonGrantor(viewer);
  if (grantor === null) {
    throw refuse(403, "CREATE_DENIED", "You can't add people to the directory", contextOf(viewer));
  }
  return grantor;
};

/** The Add person dialog's blur check: is the email free among the open Employments. */
export const checkDirectoryEmail = async (
  viewer: DirectoryViewer,
  email: string,
  tx: DbTransaction
): Promise<{ available: boolean }> => {
  assertCanCreate(viewer);
  return {
    available:
      (await findOpenEmploymentByEmail(viewer.organizationId, email, {}, tx)) === undefined,
  };
};

/**
 * Add person: opens an Employment without an account, holding the person's
 * name and optional email, and writes the Card fields given. The Create act
 * covers those fields; it needs no Card write cell of its own. One Card
 * history row records the name and every field set.
 */
export const createDirectoryPerson = async (
  viewer: DirectoryViewer,
  input: PostDirectoryPerson,
  tx: DbTransaction
): Promise<DirectoryProfile> => {
  const { organizationId } = viewer;
  const grantor = assertCanCreate(viewer);
  await assertDirectoryWritable(organizationId, tx);

  const employmentId = generateRandomUUID();
  const context = { ...contextOf(viewer), employmentId };
  const card = Object.fromEntries(
    Object.entries(input.card ?? {}).filter(([, value]) => value !== null && value !== undefined)
  ) as { [K in keyof NonNullable<PostDirectoryPerson["card"]>]?: string };

  if (card.departmentId) {
    await assertAssignableEntry("departments", organizationId, card.departmentId, context, tx);
  }
  if (card.locationId) {
    await assertAssignableEntry("locations", organizationId, card.locationId, context, tx);
  }
  if (card.reportsToEmploymentId) {
    await assertReportsTo(
      organizationId,
      { id: employmentId, userId: null },
      card.reportsToEmploymentId,
      context,
      tx
    );
  }

  const email = input.email ?? null;
  if (email) await assertEmploymentEmailFree(organizationId, email, context, tx);

  await tx.insert(employments).values({
    id: employmentId,
    organizationId,
    userId: null,
    type: input.type,
    name: input.name,
    email,
  });

  if (Object.keys(card).length > 0) {
    await tx.insert(directoryProfiles).values({ employmentId, organizationId, ...card });
  }
  const fields = [
    "name",
    ...Object.entries(CARD_COLUMNS)
      .filter(([column]) => column in card)
      .map(([, field]) => field),
  ];
  await recordProfileHistory(
    [
      {
        organizationId,
        employmentId,
        actorUserId: viewer.standing.userId,
        section: directoryPermissionRow.Card,
        fields,
        audience: grantor,
      },
    ],
    tx
  );

  return getDirectoryProfile(viewer, employmentId, tx);
};
