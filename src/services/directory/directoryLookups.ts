import { db } from "../../db/db.js";
import type { appLanguage } from "../../db/schema/user-settings-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import AppError, { refuse } from "../../utils/appError.js";
import { DIRECTORY_PLAN_REQUIRED, isDirectoryWritable } from "../billing/guards.js";
import { listDirectoryPeople, listFormerDirectoryPeople } from "./directoryPeopleServices.js";
import { getDirectoryProfile } from "./directoryProfileServices.js";
import { isDirectoryOrganization } from "./directorySettings.js";
import { listDirectoryOrganizations } from "./directorySettingsServices.js";
import { loadDirectoryViewer } from "./directoryViewer.js";
import { isSensitiveSectionKey } from "./sectionKeys.js";
import { showSensitiveSection } from "./showSectionServices.js";

/** Which organization's directory, and the language server-made strings come in. */
type DirectoryScope = {
  auth: AuthSession;
  organizationId: string;
  language?: appLanguage | `${appLanguage}`;
};

const viewerOf = ({ auth, organizationId, language }: DirectoryScope) =>
  loadDirectoryViewer(auth.userId, organizationId, undefined, {
    language: language as appLanguage | undefined,
  });

/**
 * The web's plan rule for a directory that is off: on a plan without the
 * directory the answer is the plan, not the setting. A directory that is on
 * stays readable after a downgrade, as every directory read does. REST keeps
 * its 409 `DIRECTORY_OFF`; the tools call this first.
 */
export const assertDirectoryPlan = async (params: { organizationId: string }) => {
  const { organizationId } = params;
  if (await isDirectoryOrganization(organizationId)) return;
  if (await isDirectoryWritable(organizationId)) return;
  throw new AppError({
    message: "The people directory requires the Enterprise plan",
    logging: false,
    code: 402,
    context: { organizationId },
    publicContext: { reason: "PLAN_LIMIT", code: DIRECTORY_PLAN_REQUIRED },
  });
};

export const readDirectoryOrganizations = async (params: { auth: AuthSession }) =>
  listDirectoryOrganizations(params.auth.userId);

export const readDirectoryPeople = async (params: DirectoryScope) =>
  listDirectoryPeople(await viewerOf(params));

export const readFormerDirectoryPeople = async (params: DirectoryScope) =>
  listFormerDirectoryPeople(await viewerOf(params));

/** The profile with every Sensitive section closed: opening one is `showProfileSection`. */
export const readDirectoryProfile = async (params: DirectoryScope & { employmentId: string }) =>
  getDirectoryProfile(await viewerOf(params), params.employmentId);

/**
 * Opens one Sensitive section of a profile and writes its Read log entry in
 * the same transaction, so a value never leaves without its row.
 */
export const showProfileSection = async (
  params: DirectoryScope & { employmentId: string; section: string }
) => {
  const { auth, organizationId, language, employmentId, section } = params;
  if (!isSensitiveSectionKey(section)) {
    throw refuse(404, "SECTION_NOT_FOUND", "Only Contact and Personal open with Show", { section });
  }

  return db.transaction(async (tx) =>
    showSensitiveSection(
      await loadDirectoryViewer(auth.userId, organizationId, tx, {
        language: language as appLanguage | undefined,
      }),
      employmentId,
      section,
      auth.channel,
      tx
    )
  );
};
