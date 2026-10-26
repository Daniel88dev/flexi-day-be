import { and, desc, eq, isNotNull, lt, ne } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryPhotos, directoryPhotoStatus } from "../../db/schema/directory-photo-schema.js";
import {
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import AppError, { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertDirectoryWritable } from "../billing/guards.js";
import {
  photoKeys,
  photoPrefix,
  removePhotoObjects,
  requireStore,
} from "./directoryPhotoServices.js";
import { administersPeople, lockRecordInReach, type DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryAccess, SectionRow } from "./permissionResolver.js";
import { CONTACT_FIELDS, PERSONAL_FIELDS, PHOTO_FIELDS } from "./profileSectionFields.js";
import { recordProfileHistory } from "./profileHistory.js";
import { samePersonAs } from "../employment/personSpells.js";
import { readRetentionSchedules } from "./retentionSchedule.js";
import { readSensitiveSection, writeSensitiveSections } from "./sensitiveSections.js";
import {
  COPYABLE_SECTION_KEYS,
  type CopyableSection,
  type CopyableSectionKey,
  type PostCopyPreviousSpell,
  type PreviousSpellView,
} from "./types.js";

const SECTION_ROW: Record<CopyableSectionKey, SectionRow> = {
  contact: R.Contact,
  personal: R.Personal,
  photo: R.Photo,
};

type SpellRecord = {
  id: string;
  userId: string | null;
  email: string | null;
  type: workerType;
  startedAt: Date;
  endedAt: Date | null;
};

type PreviousSpell = { id: string; startedAt: Date; endedAt: Date };

/**
 * The latest ended spell of the same person in the organization, begun before
 * this one: the same user, or the same email when either spell has no account.
 */
const findPreviousSpell = async (
  organizationId: string,
  record: SpellRecord,
  tx?: DbTransaction
): Promise<PreviousSpell | null> => {
  const samePerson = samePersonAs(record);
  if (!samePerson) return null;
  const [row] = await (tx ?? db)
    .select({
      id: employments.id,
      startedAt: employments.startedAt,
      endedAt: employments.endedAt,
    })
    .from(employments)
    .where(
      and(
        eq(employments.organizationId, organizationId),
        ne(employments.id, record.id),
        isNotNull(employments.endedAt),
        lt(employments.startedAt, record.startedAt),
        samePerson
      )
    )
    .orderBy(desc(employments.endedAt), desc(employments.startedAt))
    .limit(1);
  return row ? { id: row.id, startedAt: row.startedAt, endedAt: row.endedAt! } : null;
};

const readyPhotoOf = async (employmentId: string, tx?: DbTransaction) => {
  const [photo] = await (tx ?? db)
    .select()
    .from(directoryPhotos)
    .where(
      and(
        eq(directoryPhotos.employmentId, employmentId),
        eq(directoryPhotos.status, directoryPhotoStatus.Ready)
      )
    );
  return photo;
};

/** What each copyable Section of the previous spell offers this spell. */
const copyableSections = async (
  viewer: DirectoryViewer,
  record: SpellRecord,
  access: DirectoryAccess,
  previous: PreviousSpell,
  tx?: DbTransaction
): Promise<Partial<Record<CopyableSectionKey, CopyableSection>>> => {
  const schedules = await readRetentionSchedules(
    viewer.organizationId,
    [previous.id, record.id],
    tx
  );
  const from = schedules.get(previous.id)!.sections;
  const into = schedules.get(record.id)!.sections;
  const previousPhoto = await readyPhotoOf(previous.id, tx);
  const sections: Partial<Record<CopyableSectionKey, CopyableSection>> = {};
  for (const key of COPYABLE_SECTION_KEYS) {
    if (key === "personal" && record.type === workerType.External) continue;
    const row = SECTION_ROW[key];
    const held = key === "photo" ? previousPhoto !== undefined : from[row].holds;
    sections[key] = !held
      ? from[row].removedOn !== null
        ? { status: "REMOVED_ON", date: from[row].removedOn }
        : { status: "EMPTY" }
      : into[row].holds
        ? { status: "FILLED" }
        : access.sections[row] !== V.Write
          ? { status: "NOT_WRITABLE" }
          : { status: "COPYABLE" };
  }
  return sections;
};

/**
 * Whether the profile offers Copy from previous spell: the owner, org admins
 * and HR, on an open record whose previous spell holds a Section they can copy.
 */
export const copyFromPreviousSpellOffered = async (
  viewer: DirectoryViewer,
  record: SpellRecord,
  access: DirectoryAccess,
  tx?: DbTransaction
): Promise<boolean> => {
  if (!administersPeople(viewer) || record.endedAt !== null) return false;
  const previous = await findPreviousSpell(viewer.organizationId, record, tx);
  if (!previous) return false;
  const sections = await copyableSections(viewer, record, access, previous, tx);
  return Object.values(sections).some((section) => section.status === "COPYABLE");
};

/** The record and its previous spell, with the refusals both routes share. */
const loadCopy = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx: DbTransaction,
  lock: boolean
) => {
  const { record, access, context } = await lockRecordInReach(viewer, employmentId, tx, { lock });
  if (!administersPeople(viewer)) {
    throw refuse(
      403,
      "COPY_DENIED",
      "Only the owner, org admins and HR copy from a previous spell",
      context
    );
  }
  if (record.endedAt !== null) {
    throw refuse(409, "EMPLOYMENT_ENDED", "This spell has ended", context);
  }
  const previous = await findPreviousSpell(viewer.organizationId, record, tx);
  if (!previous) {
    throw refuse(404, "NO_PREVIOUS_SPELL", "This person has no previous spell here", context);
  }
  return { record, access, previous, context };
};

/** What the Copy from previous spell dialog shows. */
export const readPreviousSpell = (
  viewer: DirectoryViewer,
  employmentId: string,
  tx: DbTransaction
): Promise<PreviousSpellView> =>
  loadCopy(viewer, employmentId, tx, false).then(async ({ record, access, previous }) => ({
    previous: {
      employmentId: previous.id,
      startedAt: previous.startedAt,
      endedAt: previous.endedAt,
    },
    sections: await copyableSections(viewer, record, access, previous, tx),
  }));

const filled = (fields: readonly string[], value: Record<string, unknown> | null) =>
  value === null ? [] : fields.filter((field) => value[field] !== null);

/**
 * Copies whole Sections from the previous spell onto this open one, in the
 * caller's transaction. Sealed Sections are opened and sealed again for the
 * new row; the photo's two files are written under a new photo id. A failure
 * here deletes them; the returned folders are for the caller to delete if its
 * transaction fails later. Each copied Section gets a profile history row.
 */
export const copyFromPreviousSpell = async (
  viewer: DirectoryViewer,
  employmentId: string,
  input: PostCopyPreviousSpell,
  tx: DbTransaction
): Promise<{ photoPrefixes: string[] }> => {
  const { record, access, previous, context } = await loadCopy(viewer, employmentId, tx, true);
  const { organizationId } = viewer;
  const chosen = [...new Set(input.sections)];

  await tx
    .select({ id: directorySensitiveProfiles.employmentId })
    .from(directorySensitiveProfiles)
    .where(eq(directorySensitiveProfiles.employmentId, previous.id))
    .for("share");
  await tx
    .select({ id: directoryPhotos.id })
    .from(directoryPhotos)
    .where(eq(directoryPhotos.employmentId, previous.id))
    .for("share");

  const sections = await copyableSections(viewer, record, access, previous, tx);
  for (const key of chosen) {
    const section = sections[key];
    const sectionContext = { ...context, section: key, previousEmploymentId: previous.id };
    if (!section) {
      throw refuse(422, "EMPLOYEES_ONLY", "Personal applies to employees only", sectionContext);
    }
    if (section.status === "NOT_WRITABLE") {
      throw refuse(403, "SECTION_NOT_WRITABLE", "You can't change this Section", sectionContext);
    }
    if (section.status === "FILLED") {
      throw refuse(
        409,
        "SECTION_ALREADY_FILLED",
        "This spell already holds the Section",
        sectionContext
      );
    }
    if (section.status !== "COPYABLE") {
      throw refuse(
        409,
        "SECTION_NOT_HELD",
        "The previous spell no longer holds the Section",
        sectionContext
      );
    }
  }
  await assertDirectoryWritable(organizationId, tx);

  const history: { section: SectionRow; fields: string[] }[] = [];

  if (chosen.includes("contact") || chosen.includes("personal")) {
    const from = await readSensitiveSection(organizationId, previous.id, tx);
    const into = await readSensitiveSection(organizationId, record.id, tx);
    const contact = chosen.includes("contact") ? from.contact : into.contact;
    const personal = chosen.includes("personal") ? from.personal : into.personal;
    await writeSensitiveSections(organizationId, record.id, { contact, personal }, tx);
    if (chosen.includes("contact")) {
      history.push({ section: R.Contact, fields: filled(CONTACT_FIELDS, from.contact) });
    }
    if (chosen.includes("personal")) {
      history.push({ section: R.Personal, fields: filled(PERSONAL_FIELDS, from.personal) });
    }
  }

  const photoPrefixes: string[] = [];
  const copyPhoto = async () => {
    if (!chosen.includes("photo")) return;
    const photo = (await readyPhotoOf(previous.id, tx))!;
    const store = requireStore(context);
    const source = photoKeys(photoPrefix(photo));
    const small = await store.getObject(source.small);
    const full = await store.getObject(source.full);
    if (!small || !full) {
      throw new AppError({
        code: 409,
        message: "The previous spell's photo files are missing",
        logging: true,
        context: { ...context, photoId: photo.id },
        publicContext: { code: "SECTION_NOT_HELD" },
      });
    }
    const copy = { id: generateRandomUUID(), organizationId, employmentId: record.id };
    const prefix = photoPrefix(copy);
    photoPrefixes.push(prefix);
    const target = photoKeys(prefix);
    await store.putObject(target.small, small, "image/jpeg");
    await store.putObject(target.full, full, "image/jpeg");
    await tx.insert(directoryPhotos).values({
      ...copy,
      status: directoryPhotoStatus.Ready,
      contentType: "image/jpeg",
      size: full.length,
      uploadedByUserId: viewer.standing.userId,
      audience: access.grantedBy[R.Photo]!,
      readyAt: new Date(),
    });
    history.push({ section: R.Photo, fields: [...PHOTO_FIELDS] });
  };

  try {
    await copyPhoto();
    await recordProfileHistory(
      history.map(({ section, fields }) => ({
        organizationId,
        employmentId: record.id,
        actorUserId: viewer.standing.userId,
        section,
        fields,
        audience: access.grantedBy[section]!,
      })),
      tx
    );
  } catch (error) {
    await removePhotoObjects(photoPrefixes);
    throw error;
  }
  return { photoPrefixes };
};
