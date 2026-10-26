import { describe, it, expect } from "vitest";
import { workerType } from "../../../db/schema/employment-schema.js";
import { DIRECTORY_PERMISSION_DEFAULTS } from "../permissionDefaults.js";
import { resolveAccess, type PermissionCell, type ViewerStanding } from "../permissionResolver.js";

const defaults: PermissionCell[] = DIRECTORY_PERMISSION_DEFAULTS.map(
  ({ row, audience, value }) => ({
    row,
    audience,
    value,
  })
);

/** The default table with some cells replaced, written `ROW/AUDIENCE: VALUE`. */
const tableWith = (changes: Record<string, string>): PermissionCell[] =>
  defaults.map((cell) => {
    const value = changes[`${cell.row}/${cell.audience}`];
    return value ? { ...cell, value: value as PermissionCell["value"] } : cell;
  });

const VIEWER = "viewer-user";
const SUBJECT = "subject-user";

const standing = (overrides: Partial<ViewerStanding> = {}): ViewerStanding => ({
  userId: VIEWER,
  owner: false,
  organizationAdmin: false,
  employmentType: null,
  roles: [],
  groupAdminReach: new Set(),
  ...overrides,
});

const colleague = (overrides: Partial<ViewerStanding> = {}) =>
  standing({ employmentType: workerType.Employee, ...overrides });

const openRecord = { userId: SUBJECT, ended: false };
const endedRecord = { userId: SUBJECT, ended: true };
const ownRecord = { userId: VIEWER, ended: false };

/** Section levels in the order Card, Photo, Work contact, Job, Contact, Personal. */
const levels = (cells: PermissionCell[], viewer: ViewerStanding, record = openRecord) => {
  const { sections } = resolveAccess(cells, viewer, record);
  return [
    sections.CARD,
    sections.PHOTO,
    sections.WORK_CONTACT,
    sections.JOB,
    sections.CONTACT,
    sections.PERSONAL,
  ].join(" ");
};

describe("resolveAccess, one audience at a time on the default table", () => {
  it("gives the owner write on every Section", () => {
    expect(levels(defaults, standing({ owner: true }))).toBe("WRITE WRITE WRITE WRITE WRITE WRITE");
  });

  it("gives Self the Self column on their own record", () => {
    expect(levels(defaults, standing(), ownRecord)).toBe("READ WRITE READ READ WRITE WRITE");
  });

  it("gives a Colleague Card, Photo and Work contact", () => {
    expect(levels(defaults, colleague())).toBe("READ READ READ NONE NONE NONE");
  });

  it("gives an External worker Card and Photo, in place of the Colleague column", () => {
    expect(levels(defaults, standing({ employmentType: workerType.External }))).toBe(
      "READ READ NONE NONE NONE NONE"
    );
  });

  it("gives a Group admin their column for a plain member they reach", () => {
    const viewer = colleague({ groupAdminReach: new Set([SUBJECT]) });
    expect(levels(defaults, viewer)).toBe("READ READ READ READ NONE NONE");
  });

  it("gives a Group admin nothing beyond Colleague for someone outside their groups", () => {
    const viewer = colleague({ groupAdminReach: new Set(["someone-else"]) });
    expect(levels(defaults, viewer)).toBe("READ READ READ NONE NONE NONE");
  });

  it("gives HR write on every Section", () => {
    expect(levels(defaults, colleague({ roles: ["HR"] }))).toBe(
      "WRITE WRITE WRITE WRITE WRITE WRITE"
    );
  });

  it("gives Leadership the non-sensitive Sections to read", () => {
    expect(levels(defaults, colleague({ roles: ["LEADERSHIP"] }))).toBe(
      "READ READ READ READ NONE NONE"
    );
  });

  it("gives an org admin write on every Section", () => {
    expect(levels(defaults, colleague({ organizationAdmin: true }))).toBe(
      "WRITE WRITE WRITE WRITE WRITE WRITE"
    );
  });

  it("gives someone with no standing nothing", () => {
    expect(levels(defaults, standing())).toBe("NONE NONE NONE NONE NONE NONE");
  });

  it("names the audiences that credit the viewer", () => {
    const viewer = colleague({ groupAdminReach: new Set([SUBJECT]), roles: ["LEADERSHIP"] });
    expect(resolveAccess(defaults, viewer, openRecord).audiences).toEqual([
      "COLLEAGUE",
      "GROUP_ADMIN",
      "LEADERSHIP",
    ]);
  });
});

describe("resolveAccess, widest cell wins", () => {
  it("takes the wider of Colleague and Group admin per Section", () => {
    const cells = tableWith({ "PHOTO/GROUP_ADMIN": "NONE", "JOB/COLLEAGUE": "READ" });
    const viewer = colleague({ groupAdminReach: new Set([SUBJECT]) });
    expect(levels(cells, viewer)).toBe("READ READ READ READ NONE NONE");
  });

  it("lets Leadership widen a Colleague's view", () => {
    const cells = tableWith({ "CONTACT/LEADERSHIP": "READ" });
    expect(levels(cells, colleague({ roles: ["LEADERSHIP"] }))).toBe(
      "READ READ READ READ READ NONE"
    );
  });

  it("applies on the viewer's own record too", () => {
    const cells = tableWith({ "CARD/HR": "WRITE", "JOB/HR": "WRITE" });
    expect(levels(cells, colleague({ roles: ["HR"] }), ownRecord)).toBe(
      "WRITE WRITE WRITE WRITE WRITE WRITE"
    );
  });

  it("lets an org admin who is also a group admin keep the org admin column", () => {
    const viewer = colleague({ organizationAdmin: true, groupAdminReach: new Set([SUBJECT]) });
    expect(levels(defaults, viewer)).toBe("WRITE WRITE WRITE WRITE WRITE WRITE");
  });
});

describe("resolveAccess, fixed floors", () => {
  it("keeps the owner at write whatever the stored Owner cells say", () => {
    const cells = tableWith({ "CARD/OWNER": "NONE", "CONTACT/OWNER": "READ" });
    expect(levels(cells, standing({ owner: true }))).toBe("WRITE WRITE WRITE WRITE WRITE WRITE");
  });

  it("lets Self read every Section of their own open record even when a Self cell is none", () => {
    const cells = tableWith({
      "CARD/SELF": "NONE",
      "WORK_CONTACT/SELF": "NONE",
      "JOB/SELF": "NONE",
      "PHOTO/SELF": "NONE",
    });
    expect(levels(cells, standing(), ownRecord)).toBe("READ READ READ READ WRITE WRITE");
  });

  it("never lets a Colleague or an External worker write, whatever the cell holds", () => {
    const cells = tableWith({
      "CARD/COLLEAGUE": "WRITE",
      "CARD/EXTERNAL_WORKER": "WRITE",
    });
    expect(resolveAccess(cells, colleague(), openRecord).sections.CARD).toBe("READ");
    expect(
      resolveAccess(cells, standing({ employmentType: workerType.External }), openRecord).sections
        .CARD
    ).toBe("READ");
  });

  it("treats a missing cell as none", () => {
    const cells = defaults.filter(
      (cell) => !(cell.row === "CARD" && cell.audience === "COLLEAGUE")
    );
    expect(resolveAccess(cells, colleague(), openRecord).sections.CARD).toBe("NONE");
  });
});

describe("resolveAccess, the Former list", () => {
  it("reaches an ended record for the owner, an org admin and HR", () => {
    expect(levels(defaults, standing({ owner: true }), endedRecord)).toBe(
      "WRITE WRITE WRITE WRITE WRITE WRITE"
    );
    expect(levels(defaults, colleague({ organizationAdmin: true }), endedRecord)).toBe(
      "WRITE WRITE WRITE WRITE WRITE WRITE"
    );
    expect(levels(defaults, colleague({ roles: ["HR"] }), endedRecord)).toBe(
      "WRITE WRITE WRITE WRITE WRITE WRITE"
    );
  });

  it("reaches an ended record for nobody else, the person themself included", () => {
    const groupAdmin = colleague({ groupAdminReach: new Set([SUBJECT]) });
    for (const viewer of [
      colleague(),
      standing({ employmentType: workerType.External }),
      groupAdmin,
      colleague({ roles: ["LEADERSHIP"] }),
    ]) {
      expect(levels(defaults, viewer, endedRecord)).toBe("NONE NONE NONE NONE NONE NONE");
    }
    expect(levels(defaults, colleague(), { userId: VIEWER, ended: true })).toBe(
      "NONE NONE NONE NONE NONE NONE"
    );
  });

  it("opens the Former list to the owner, org admins and HR only", () => {
    expect(resolveAccess(defaults, standing({ owner: true }), endedRecord).inReach).toBe(true);
    expect(resolveAccess(defaults, colleague({ roles: ["HR"] }), endedRecord).inReach).toBe(true);
    expect(resolveAccess(defaults, colleague({ roles: ["LEADERSHIP"] }), endedRecord).inReach).toBe(
      false
    );
  });
});

describe("resolveAccess, reach and record facts", () => {
  it("puts a record in reach only when the viewer reads its Card", () => {
    const cells = tableWith({ "CARD/COLLEAGUE": "NONE" });
    expect(resolveAccess(cells, colleague(), openRecord).inReach).toBe(false);
    expect(resolveAccess(defaults, colleague(), openRecord).inReach).toBe(true);
  });

  it("never lets a group admin reach a person without an account", () => {
    const viewer = standing({ groupAdminReach: new Set([SUBJECT]) });
    expect(resolveAccess(defaults, viewer, { userId: null, ended: false }).audiences).toEqual([]);
  });

  it("shows the restricted markers to the owner, org admins and HR only", () => {
    const sees = (viewer: ViewerStanding, record = openRecord) =>
      resolveAccess(defaults, viewer, record).restrictedMarkers;
    expect(sees(standing({ owner: true }))).toBe(true);
    expect(sees(colleague({ organizationAdmin: true }))).toBe(true);
    expect(sees(colleague({ roles: ["HR"] }))).toBe(true);
    expect(sees(colleague({ roles: ["LEADERSHIP"] }))).toBe(false);
    expect(sees(colleague({ groupAdminReach: new Set([SUBJECT]) }))).toBe(false);
    expect(sees(colleague(), ownRecord)).toBe(false);
  });

  it("shows the account facts to the owner, org admins, HR and the person", () => {
    const sees = (viewer: ViewerStanding, record = openRecord) =>
      resolveAccess(defaults, viewer, record).accountFacts;
    expect(sees(standing({ owner: true }))).toBe(true);
    expect(sees(colleague({ organizationAdmin: true }))).toBe(true);
    expect(sees(colleague({ roles: ["HR"] }))).toBe(true);
    expect(sees(colleague(), ownRecord)).toBe(true);
    expect(sees(colleague({ roles: ["LEADERSHIP"] }))).toBe(false);
    expect(sees(colleague())).toBe(false);
  });
});

describe("resolveAccess, directory acts", () => {
  it("allows the owner every act, even with a stored no", () => {
    const cells = tableWith({ "END_EMPLOYMENT/OWNER": "NO" });
    const { acts } = resolveAccess(cells, standing({ owner: true }), openRecord);
    expect(Object.values(acts).every(Boolean)).toBe(true);
  });

  it("follows the HR and org admin cells, and gives Colleagues no act", () => {
    const cells = tableWith({ "CHANGE_WORKER_TYPE/HR": "NO" });
    const hr = resolveAccess(cells, colleague({ roles: ["HR"] }), openRecord).acts;
    expect(hr.CHANGE_WORKER_TYPE).toBe(false);
    expect(hr.END_EMPLOYMENT).toBe(true);
    expect(resolveAccess(defaults, colleague(), openRecord).acts.END_EMPLOYMENT).toBe(false);
    expect(
      resolveAccess(defaults, colleague({ organizationAdmin: true }), openRecord).acts
        .SEND_DIRECTORY_INVITE
    ).toBe(true);
  });

  it("lets a stored allowed on Group admin through for a member they reach", () => {
    const cells = tableWith({ "SEND_DIRECTORY_INVITE/GROUP_ADMIN": "ALLOWED" });
    const viewer = colleague({ groupAdminReach: new Set([SUBJECT]) });
    expect(resolveAccess(cells, viewer, openRecord).acts.SEND_DIRECTORY_INVITE).toBe(true);
    expect(resolveAccess(defaults, viewer, openRecord).acts.SEND_DIRECTORY_INVITE).toBe(false);
  });
});

describe("resolveAccess, the granting audience", () => {
  it("names the audience whose cell gave the widest level", () => {
    const { grantedBy } = resolveAccess(
      defaults,
      standing({ organizationAdmin: true }),
      openRecord
    );
    expect(grantedBy.CARD).toBe("ORGANIZATION_ADMIN");
    expect(grantedBy.JOB).toBe("ORGANIZATION_ADMIN");
  });

  it("names the owner before any other audience the owner also holds", () => {
    const viewer = colleague({ owner: true, organizationAdmin: true });
    expect(resolveAccess(defaults, viewer, openRecord).grantedBy.CARD).toBe("OWNER");
  });

  it("names Self for the person's own Sections, and the wider audience where one wins", () => {
    const viewer = colleague({ organizationAdmin: true });
    const { grantedBy } = resolveAccess(defaults, viewer, ownRecord);
    expect(grantedBy.CONTACT).toBe("SELF");
    expect(grantedBy.CARD).toBe("ORGANIZATION_ADMIN");
  });

  it("names nobody for a Section the viewer can't read", () => {
    expect(resolveAccess(defaults, colleague(), openRecord).grantedBy.JOB).toBeNull();
  });
});

describe("resolveAccess, both Directory roles on one person", () => {
  it("credits HR and Leadership together, and the wider cell wins per Section", () => {
    const cells = tableWith({ "CONTACT/HR": "READ", "CONTACT/LEADERSHIP": "WRITE" });
    const viewer = colleague({ roles: ["HR", "LEADERSHIP"] });
    const access = resolveAccess(cells, viewer, openRecord);
    expect(access.audiences).toEqual(["COLLEAGUE", "HR", "LEADERSHIP"]);
    expect(levels(cells, viewer)).toBe("WRITE WRITE WRITE WRITE WRITE WRITE");
    expect(access.grantedBy.CONTACT).toBe("LEADERSHIP");
    expect(access.grantedBy.CARD).toBe("HR");
  });

  it("keeps only the HR column on an ended record", () => {
    const cells = tableWith({ "JOB/HR": "READ", "JOB/LEADERSHIP": "WRITE" });
    const access = resolveAccess(cells, colleague({ roles: ["HR", "LEADERSHIP"] }), endedRecord);
    expect(access.audiences).toEqual(["HR"]);
    expect(access.sections.JOB).toBe("READ");
  });

  it("follows a stored allowed on Leadership for an act", () => {
    const cells = tableWith({ "END_EMPLOYMENT/LEADERSHIP": "ALLOWED" });
    const viewer = colleague({ roles: ["LEADERSHIP"] });
    expect(resolveAccess(cells, viewer, openRecord).acts.END_EMPLOYMENT).toBe(true);
    expect(resolveAccess(defaults, viewer, openRecord).acts.END_EMPLOYMENT).toBe(false);
  });
});
