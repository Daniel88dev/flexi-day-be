import { PERSONAS, type EvalCase, type Expectation, type SeedRefs } from "./types.js";

/**
 * Stand-in ids for reading a case without a database: listing cases and the
 * coverage rules only look at tool names, never at the ids a case names.
 */
export const placeholderSeed = (): SeedRefs => ({
  organizationId: "seed-organization",
  groups: { team: "seed-group-team", hidden: "seed-group-hidden", second: "seed-group-second" },
  users: Object.fromEntries(
    PERSONAS.map((persona) => [persona, { id: `seed-user-${persona}`, name: persona }])
  ) as SeedRefs["users"],
  requests: {
    memberPending: "seed-request-member-pending",
    memberApproved: "seed-request-member-approved",
    colleaguePending: "seed-request-colleague-pending",
  },
  employments: Object.fromEntries(
    PERSONAS.map((persona) => [persona, `seed-employment-${persona}`])
  ) as SeedRefs["employments"],
});

export const resolveExpectation = <E extends Expectation>(
  evalCase: EvalCase<E>,
  seed: SeedRefs = placeholderSeed()
): E => (typeof evalCase.expect === "function" ? evalCase.expect(seed) : evalCase.expect);

export const resolveMessage = (evalCase: EvalCase, seed: SeedRefs = placeholderSeed()): string =>
  typeof evalCase.message === "function" ? evalCase.message(seed) : evalCase.message;
