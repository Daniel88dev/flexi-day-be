import { describe, it, expect } from "vitest";
import { cellRule, checkCellChange, withDefaultCells } from "../permissionTable.js";

describe("cellRule", () => {
  it("fixes the Owner column on every row", () => {
    expect(cellRule("CARD" as never, "OWNER" as never)).toEqual({
      fixed: true,
      options: ["WRITE"],
    });
    expect(cellRule("END_EMPLOYMENT" as never, "OWNER" as never)).toEqual({
      fixed: true,
      options: ["ALLOWED"],
    });
  });

  it("fixes Self at read on Card and Job, and offers read or write elsewhere", () => {
    expect(cellRule("CARD" as never, "SELF" as never)).toEqual({ fixed: true, options: ["READ"] });
    expect(cellRule("JOB" as never, "SELF" as never)).toEqual({ fixed: true, options: ["READ"] });
    expect(cellRule("CONTACT" as never, "SELF" as never)).toEqual({
      fixed: false,
      options: ["READ", "WRITE"],
    });
  });

  it("offers Colleague and External worker only none and read", () => {
    expect(cellRule("CARD" as never, "COLLEAGUE" as never)?.options).toEqual(["NONE", "READ"]);
    expect(cellRule("PERSONAL" as never, "EXTERNAL_WORKER" as never)?.options).toEqual([
      "NONE",
      "READ",
    ]);
  });

  it("offers the admin columns none, read and write on Sections and allowed or no on acts", () => {
    expect(cellRule("JOB" as never, "LEADERSHIP" as never)).toEqual({
      fixed: false,
      options: ["NONE", "READ", "WRITE"],
    });
    expect(cellRule("CHANGE_WORKER_TYPE" as never, "HR" as never)).toEqual({
      fixed: false,
      options: ["NO", "ALLOWED"],
    });
  });

  it("has no cell for Self, Colleague or External worker on an act, nor Group admin on End", () => {
    expect(cellRule("SEND_DIRECTORY_INVITE" as never, "SELF" as never)).toBeNull();
    expect(cellRule("SEND_DIRECTORY_INVITE" as never, "COLLEAGUE" as never)).toBeNull();
    expect(cellRule("END_EMPLOYMENT" as never, "GROUP_ADMIN" as never)).toBeNull();
    expect(cellRule("CREATE_ACCOUNTLESS_PERSON" as never, "GROUP_ADMIN" as never)).not.toBeNull();
  });
});

describe("checkCellChange", () => {
  const change = (row: string, audience: string, before: string, after: string) =>
    checkCellChange(
      { row: row as never, audience: audience as never, value: after as never },
      {
        before: before as never,
      }
    );

  it("passes a change the cell offers, and says whether it widens", () => {
    expect(change("JOB", "GROUP_ADMIN", "READ", "WRITE")).toEqual({ ok: true, widens: true });
    expect(change("JOB", "GROUP_ADMIN", "READ", "NONE")).toEqual({ ok: true, widens: false });
    expect(change("END_EMPLOYMENT", "HR", "NO", "ALLOWED")).toEqual({ ok: true, widens: true });
    expect(change("END_EMPLOYMENT", "HR", "ALLOWED", "NO")).toEqual({ ok: true, widens: false });
    expect(change("CARD", "HR", "WRITE", "WRITE")).toEqual({ ok: true, widens: false });
  });

  it("refuses a fixed cell, even to its own value", () => {
    expect(change("CARD", "OWNER", "WRITE", "READ")).toEqual({ ok: false, code: "CELL_FIXED" });
    expect(change("JOB", "SELF", "READ", "READ")).toEqual({ ok: false, code: "CELL_FIXED" });
  });

  it("refuses write for Colleague and External worker, and none for Self", () => {
    expect(change("CARD", "COLLEAGUE", "READ", "WRITE")).toEqual({
      ok: false,
      code: "VALUE_NOT_OFFERED",
    });
    expect(change("PHOTO", "EXTERNAL_WORKER", "READ", "WRITE")).toEqual({
      ok: false,
      code: "VALUE_NOT_OFFERED",
    });
    expect(change("CONTACT", "SELF", "WRITE", "NONE")).toEqual({
      ok: false,
      code: "VALUE_NOT_OFFERED",
    });
  });

  it("refuses an act value on a Section and a Section value on an act", () => {
    expect(change("CARD", "HR", "WRITE", "ALLOWED").ok).toBe(false);
    expect(change("END_EMPLOYMENT", "HR", "ALLOWED", "WRITE").ok).toBe(false);
  });

  it("refuses a cell the table doesn't have", () => {
    expect(change("END_EMPLOYMENT", "GROUP_ADMIN", "NO", "ALLOWED")).toEqual({
      ok: false,
      code: "NO_SUCH_CELL",
    });
  });
});

describe("withDefaultCells", () => {
  it("keeps every stored value and fills a missing cell with the product default", () => {
    const cells = withDefaultCells([
      { row: "JOB" as never, audience: "COLLEAGUE" as never, value: "READ" as never },
    ]);
    const value = (row: string, audience: string) =>
      cells.find((cell) => cell.row === row && cell.audience === audience)?.value;

    expect(cells).toHaveLength(72);
    expect(value("JOB", "COLLEAGUE")).toBe("READ");
    expect(value("JOB", "HR")).toBe("WRITE");
    expect(value("END_EMPLOYMENT", "LEADERSHIP")).toBe("NO");
    expect(value("END_EMPLOYMENT", "GROUP_ADMIN")).toBeUndefined();
  });
});

describe("Manage departments and locations", () => {
  it("defaults to the owner (fixed), HR and org admins, and refuses Group admin and Leadership", () => {
    const row = withDefaultCells([]).filter(
      (cell) => cell.row === ("MANAGE_DEPARTMENTS_AND_LOCATIONS" as never)
    );
    expect(row.map((cell) => [cell.audience, cell.value])).toEqual([
      ["OWNER", "ALLOWED"],
      ["GROUP_ADMIN", "NO"],
      ["HR", "ALLOWED"],
      ["LEADERSHIP", "NO"],
      ["ORGANIZATION_ADMIN", "ALLOWED"],
    ]);
    expect(cellRule("MANAGE_DEPARTMENTS_AND_LOCATIONS" as never, "OWNER" as never)?.fixed).toBe(
      true
    );
  });
});
