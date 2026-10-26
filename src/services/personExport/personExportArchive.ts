import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { ZipArchive } from "archiver";
import type { ExportAttachmentFile, PersonExportContent } from "./personExportData.js";

type Cell = string | number | boolean | Date | null | undefined;

// A spreadsheet runs a cell that starts like a formula; the leading quote keeps it text.
const FORMULA_START = /^[=+\-@\t\r]/;

const cell = (value: Cell): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (headers: string[], rows: Cell[][]): string =>
  [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";

const breakMinutes = (breaks: { startedAt: Date; endedAt: Date | null }[]) =>
  Math.round(
    breaks.reduce(
      (sum, entry) =>
        sum + ((entry.endedAt?.getTime() ?? entry.startedAt.getTime()) - entry.startedAt.getTime()),
      0
    ) / 60_000
  );

export const csvFiles = ({ person }: PersonExportContent): Record<string, string> => ({
  "bookings.csv": toCsv(
    [
      "id",
      "request_id",
      "group",
      "day",
      "type",
      "half_day",
      "start_time",
      "end_time",
      "status",
      "note",
      "rejection_reason",
      "created_at",
      "created_by",
      "approved_at",
      "approved_by",
      "rejected_at",
      "rejected_by",
      "cancelled_at",
      "cancelled_by",
    ],
    person.bookings.map((row) => [
      row.id,
      row.requestId,
      row.groupName,
      row.day,
      row.type,
      row.halfDay,
      row.startTime,
      row.endTime,
      row.status,
      row.note,
      row.rejectionReason,
      row.createdAt,
      row.createdBy,
      row.approvedAt,
      row.approvedBy,
      row.rejectedAt,
      row.rejectedBy,
      row.cancelledAt,
      row.cancelledBy,
    ])
  ),
  "attendance-sessions.csv": toCsv(
    [
      "id",
      "business_date",
      "started_at",
      "ended_at",
      "timezone",
      "origin",
      "closed_by",
      "break_minutes",
      "changed_after_day",
      "deleted_at",
      "start_latitude",
      "start_longitude",
      "start_accuracy",
      "end_latitude",
      "end_longitude",
      "end_accuracy",
    ],
    person.attendanceSessions.map((row) => [
      row.id,
      row.businessDate,
      row.startedAt,
      row.endedAt,
      row.timezone,
      row.origin,
      row.closedBy,
      breakMinutes(row.breaks),
      row.changedAfterDay,
      row.deletedAt,
      row.startLocation?.latitude,
      row.startLocation?.longitude,
      row.startLocation?.accuracy,
      row.endLocation?.latitude,
      row.endLocation?.longitude,
      row.endLocation?.accuracy,
    ])
  ),
  "quotas.csv": toCsv(
    ["group", "year", "vacation_days", "home_office_days", "sick_days", "carried_over_days"],
    person.quotas.map((row) => [
      row.groupName,
      row.year,
      row.vacationDays,
      row.homeOfficeDays,
      row.sickDays,
      row.carriedOverDays,
    ])
  ),
  "changes.csv": toCsv(
    ["at", "group", "type", "detail", "changed_by"],
    person.changes.map((row) => [row.at, row.groupName, row.type, row.detail, row.by])
  ),
});

type ReadFile = (file: ExportAttachmentFile) => Promise<Buffer | undefined>;

// One entry in memory at a time: each append waits until the archive has taken it.
const appendAndWait = (archive: ZipArchive, data: Buffer | string, name: string) =>
  new Promise<void>((resolve, reject) => {
    const settle = () => {
      archive.off("entry", taken);
      archive.off("error", failed);
    };
    const taken = (entry: { name: string }) => {
      if (entry.name !== name) return;
      settle();
      resolve();
    };
    const failed = (error: Error) => {
      settle();
      reject(error);
    };
    archive.on("entry", taken);
    archive.on("error", failed);
    archive.append(data, { name });
  });

/**
 * One person's entries under `prefix`: `person.json`, the four CSVs, each
 * held attachment's bytes and each spell's Profile photo. `readFile` returns
 * undefined for a file whose object is gone, and its `file` becomes null.
 */
const appendPersonEntries = async (
  archive: ZipArchive,
  prefix: string,
  content: PersonExportContent,
  readFile: ReadFile
): Promise<void> => {
  const missing = new Set<string>();
  for (const file of content.files) {
    const bytes = await readFile(file);
    if (!bytes) {
      missing.add(file.path);
      continue;
    }
    await appendAndWait(archive, bytes, `${prefix}${file.path}`);
  }
  const person = {
    ...content.person,
    employments: content.person.employments.map((spell) =>
      spell.photo && missing.has(spell.photo.file) ? { ...spell, photo: null } : spell
    ),
    attachments: content.person.attachments.map((entry) =>
      entry.file && missing.has(entry.file) ? { ...entry, file: null } : entry
    ),
  };

  await appendAndWait(archive, JSON.stringify(person, null, 2), `${prefix}person.json`);
  for (const [name, csv] of Object.entries(csvFiles({ ...content, person }))) {
    await appendAndWait(archive, csv, `${prefix}${name}`);
  }
};

const writeZip = async (
  filePath: string,
  fill: (archive: ZipArchive) => Promise<void>
): Promise<void> => {
  const output = createWriteStream(filePath);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const done = finished(output);
  let failure: unknown;
  archive.on("error", (error: unknown) => {
    failure = error;
    output.destroy(error as Error);
  });
  archive.pipe(output);

  await fill(archive);
  await archive.finalize();
  await done;
  if (failure) throw failure as Error;
};

/** Writes a Person export ZIP to `filePath`. */
export const writePersonExportZip = (
  filePath: string,
  content: PersonExportContent,
  readFile: ReadFile
): Promise<void> =>
  writeZip(filePath, (archive) => appendPersonEntries(archive, "", content, readFile));

/**
 * Writes an Organization export ZIP to `filePath`: `organization.json`, then
 * one Person export folder per person. Each person is read only when their
 * folder is written, so one person's data is in memory at a time.
 */
export const writeOrganizationExportZip = (
  filePath: string,
  content: {
    document: unknown;
    people: { folder: string; collect: () => Promise<PersonExportContent> }[];
  },
  readFile: ReadFile
): Promise<void> =>
  writeZip(filePath, async (archive) => {
    await appendAndWait(archive, JSON.stringify(content.document, null, 2), "organization.json");
    for (const person of content.people) {
      await appendPersonEntries(archive, `${person.folder}/`, await person.collect(), readFile);
    }
  });
