import { z } from "zod";
import {
  assertDirectoryPlan,
  readDirectoryPeople,
  readDirectoryProfile,
  showProfileSection,
} from "../../services/directory/directoryLookups.js";
import type { ShownSection } from "../../services/directory/types.js";
import { defineTool, type ToolContext } from "../types.js";
import { cursorField, page } from "./requestRows.js";

const scopeOf = (ctx: ToolContext) => ({
  auth: ctx.auth,
  organizationId: ctx.organizationId,
  language: ctx.language,
});

const employmentIdField = z
  .string()
  .min(1)
  .describe("The person's `employmentId` from `list_directory_people`.");

const entryName = (entry: { name: string } | null | undefined) => entry?.name ?? null;

export const listDirectoryPeopleTool = defineTool({
  name: "list_directory_people",
  description: `The people directory of this organization: the current people you can see, by name, each with their job title, department and location, and \`employmentId\` for \`get_directory_profile\`. \`personId\` is null for someone without an account. Who you see follows the organization's Permission table, as in the app. Pages of 50; pass \`nextCursor\` back as \`cursor\` for the next page.`,
  input: z.object({
    search: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Part of a name, any case. Leave out to list everyone."),
    cursor: cursorField,
  }),
  annotations: { title: "People directory", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: ["people[].name", "people[].jobTitle", "people[].department", "people[].location"],
  handler: async (ctx, input) => {
    await assertDirectoryPlan(ctx);
    const { people } = await readDirectoryPeople(scopeOf(ctx));
    const needle = input.search?.toLocaleLowerCase();
    const matching = needle
      ? people.filter((person) => person.name.toLocaleLowerCase().includes(needle))
      : people;
    const { items, nextCursor } = page(matching, input.cursor);
    return {
      people: items.map((person) => ({
        employmentId: person.employmentId,
        personId: person.user.id,
        name: person.name,
        jobTitle: person.jobTitle,
        department: entryName(person.department),
        location: entryName(person.location),
        markers: person.markers,
      })),
      nextCursor,
    };
  },
});

export const getDirectoryProfileTool = defineTool({
  name: "get_directory_profile",
  description:
    "One person's directory profile with only the sections you may read under the Permission table: card (job title, manager, department, location), work contact and job details. The Sensitive sections, contact and personal, are never included: `sensitiveSections` says which ones you may open with `show_directory_section`.",
  input: z.object({ employmentId: employmentIdField }),
  annotations: { title: "Directory profile", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: [
    "name",
    "card.jobTitle",
    "card.reportsTo.name",
    "card.department",
    "card.location",
    "workContact.workEmail",
    "workContact.workPhone",
    "job.legalName",
    "job.employeeNumber",
  ],
  handler: async (ctx, input) => {
    await assertDirectoryPlan(ctx);
    const profile = await readDirectoryProfile({
      ...scopeOf(ctx),
      employmentId: input.employmentId,
    });
    const { card, workContact, job, contact, personal } = profile.sections;
    return {
      employmentId: profile.employmentId,
      personId: profile.user.id,
      name: profile.name,
      self: profile.self,
      ended: profile.ended,
      markers: profile.markers,
      ...(card && {
        card: {
          jobTitle: card.jobTitle,
          reportsTo: card.reportsTo,
          department: entryName(card.department),
          location: entryName(card.location),
          country: card.location?.country?.name ?? null,
        },
      }),
      ...(workContact && {
        workContact: {
          workEmail: workContact.workEmail,
          workPhone: workContact.workPhone?.display ?? null,
        },
      }),
      ...(job && {
        job: {
          spell: job.spell,
          legalName: job.legalName,
          employeeNumber: job.employeeNumber,
          startDate: job.startDate,
          leavingDate: job.leavingDate,
          probationEndDate: job.probationEndDate,
          contractType: job.contractType,
          workingTime: job.workingTime,
        },
      }),
      sensitiveSections: [
        ...(contact ? ["contact" as const] : []),
        ...(personal ? ["personal" as const] : []),
      ],
    };
  },
});

const shownValues = (shown: ShownSection) => {
  const common = { section: shown.section, recorded: shown.recorded };
  if (shown.section === "CONTACT") {
    return {
      ...common,
      privatePhone: shown.privatePhone?.display ?? null,
      privateEmail: shown.privateEmail,
      emergencyContacts: [shown.emergencyContact1, shown.emergencyContact2].flatMap((entry) =>
        entry ? [{ name: entry.name, phone: entry.phone.display }] : []
      ),
    };
  }
  const address = shown.homeAddress;
  return {
    ...common,
    homeAddress: address && { ...address, country: address.country.name },
    dateOfBirth: shown.dateOfBirth,
  };
};

export const showDirectorySectionTool = defineTool({
  name: "show_directory_section",
  description:
    "Opens one Sensitive section of a person's directory profile, as Show does in the app: `contact` (private phone and email, emergency contacts) or `personal` (home address, date of birth; employees only). Opening someone else's section writes an entry in the organization's Read log, which the person and the organization's admins can see, marked as made through an AI app (`recorded: true`). Open one only when the user asked for that information.",
  input: z.object({
    employmentId: employmentIdField,
    section: z.enum(["contact", "personal"]).describe("Which Sensitive section to open."),
  }),
  annotations: { title: "Show a Sensitive section", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: [
    "privatePhone",
    "privateEmail",
    "emergencyContacts[].name",
    "emergencyContacts[].phone",
    "homeAddress.line1",
    "homeAddress.line2",
    "homeAddress.postalCode",
    "homeAddress.city",
    "homeAddress.region",
  ],
  handler: async (ctx, input) => {
    await assertDirectoryPlan(ctx);
    return shownValues(
      await showProfileSection({
        ...scopeOf(ctx),
        employmentId: input.employmentId,
        section: input.section,
      })
    );
  },
});
