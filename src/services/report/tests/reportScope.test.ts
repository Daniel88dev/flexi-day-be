import { describe, it, expect } from "vitest";
import { buildScopePredicate, canEditQuotasIn, widenReportScope } from "../reportScope.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { vacation } from "../../../db/schema/vacation-schema.js";
import type { ReportScopeEntry } from "../types.js";

const cols = { userId: vacation.userId, groupId: vacation.groupId };

const entry = (overrides: Partial<ReportScopeEntry> & { groupId: string }): ReportScopeEntry => ({
  groupName: "Group",
  access: "all",
  canEditQuotas: false,
  ...overrides,
});

const dialect = new PgDialect();

/** The predicate is opaque; assert on the SQL and bound params it compiles to. */
const render = (sql: ReturnType<typeof buildScopePredicate>) => {
  if (sql === null) return null;
  const query = dialect.sqlToQuery(sql);
  return `${query.sql} ${JSON.stringify(query.params)}`;
};

describe("buildScopePredicate", () => {
  it("returns null when the caller has no scope at all", () => {
    expect(buildScopePredicate([], "me", cols)).toBeNull();
  });

  it("returns null when the requested groups all sit outside the caller's scope", () => {
    const scope = [entry({ groupId: "g1" })];

    expect(buildScopePredicate(scope, "me", cols, { groupIds: ["other"] })).toBeNull();
  });

  it("constrains self-access groups to the caller's own rows", () => {
    const selfOnly = [entry({ groupId: "g1", access: "self" })];

    expect(render(buildScopePredicate(selfOnly, "me", cols))).toContain("me");
  });

  it("does not constrain full-access groups to the caller", () => {
    const full = [entry({ groupId: "g1", access: "all" })];

    expect(render(buildScopePredicate(full, "me", cols))).not.toContain("me");
  });

  it("keeps both branches when the caller mixes full and self access", () => {
    const mixed = [
      entry({ groupId: "g1", access: "all" }),
      entry({ groupId: "g2", access: "self" }),
    ];
    const rendered = render(buildScopePredicate(mixed, "me", cols));

    expect(rendered).toContain("g1");
    expect(rendered).toContain("g2");
    expect(rendered).toContain("me");
  });

  it("narrows to the requested groups", () => {
    const scope = [entry({ groupId: "g1" }), entry({ groupId: "g2" })];
    const rendered = render(buildScopePredicate(scope, "me", cols, { groupIds: ["g2"] }));

    expect(rendered).toContain("g2");
    expect(rendered).not.toContain("g1");
  });

  it("applies a user filter on top of the access predicate", () => {
    const scope = [entry({ groupId: "g1" })];
    const rendered = render(buildScopePredicate(scope, "me", cols, { userIds: ["u7"] }));

    expect(rendered).toContain("u7");
  });

  it("ignores an empty user filter", () => {
    const scope = [entry({ groupId: "g1" })];
    const withEmpty = render(buildScopePredicate(scope, "me", cols, { userIds: [] }));

    expect(withEmpty).toEqual(render(buildScopePredicate(scope, "me", cols)));
  });
});

describe("canEditQuotasIn", () => {
  it("is true only for a group flagged editable", () => {
    const scope = [
      entry({ groupId: "g1", canEditQuotas: true }),
      entry({ groupId: "g2", canEditQuotas: false }),
    ];

    expect(canEditQuotasIn(scope, "g1")).toBe(true);
    expect(canEditQuotasIn(scope, "g2")).toBe(false);
    expect(canEditQuotasIn(scope, "unknown")).toBe(false);
  });
});

describe("widenReportScope", () => {
  const group = (id: string, groupName: string) => ({ id, groupName });

  it("adds an administered group the caller is not a member of with full access and quota editing", () => {
    const scope = widenReportScope([], ["g1"], [group("g1", "Support")]);

    expect(scope).toEqual([
      { groupId: "g1", groupName: "Support", access: "all", canEditQuotas: true },
    ]);
  });

  it("raises a self-only membership in an administered group to full access and quota editing", () => {
    const memberships = [entry({ groupId: "g1", groupName: "Ops", access: "self" })];

    const scope = widenReportScope(memberships, ["g1"], [group("g1", "Ops")]);

    expect(scope).toEqual([
      { groupId: "g1", groupName: "Ops", access: "all", canEditQuotas: true },
    ]);
  });

  it("keeps memberships outside the administered groups as they are", () => {
    const memberships = [
      entry({ groupId: "g1", groupName: "Ops", access: "self" }),
      entry({ groupId: "g2", groupName: "Sales", access: "all", canEditQuotas: false }),
    ];

    const scope = widenReportScope(memberships, [], [group("g1", "Ops"), group("g2", "Sales")]);

    expect(scope).toEqual(memberships);
  });

  it("leaves out an administered group that is no longer live", () => {
    const scope = widenReportScope([], ["deleted", "g1"], [group("g1", "Support")]);

    expect(scope.map((e) => e.groupId)).toEqual(["g1"]);
  });

  it("follows the order of the live groups it is given", () => {
    const memberships = [entry({ groupId: "g2", groupName: "Mid", access: "self" })];

    const scope = widenReportScope(
      memberships,
      ["g1", "g3"],
      [group("g1", "Alpha"), group("g2", "Mid"), group("g3", "Zulu")]
    );

    expect(scope.map((e) => e.groupName)).toEqual(["Alpha", "Mid", "Zulu"]);
  });
});
