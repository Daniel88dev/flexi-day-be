export const PARTS = [
  "tool_args",
  "golden",
  "off_topic",
  "borderline",
  "attacks",
  "injection",
] as const;
export type Part = (typeof PARTS)[number];

export const LANGS = ["en", "cs"] as const;
export type Lang = (typeof LANGS)[number];

export const PERSONAS = [
  "owner",
  "approver",
  "member",
  "colleague",
  "hidden",
  "admin",
  "newcomer",
  "multiGroup",
] as const;
export type PersonaKey = (typeof PERSONAS)[number];

/** Ids the seed wrote, for cases that name a record. */
export type SeedRefs = {
  organizationId: string;
  groups: { team: string; hidden: string; second: string };
  users: Record<PersonaKey, { id: string; name: string }>;
  requests: {
    /** The member's own pending two-day vacation, its note planted with an injection. */
    memberPending: string;
    /** The member's approved day. */
    memberApproved: string;
    /** The colleague's pending request waiting on the approver, its note planted. */
    colleaguePending: string;
  };
  employments: Partial<Record<PersonaKey, string>>;
};

export type ArgMatcher =
  { $oneOf: readonly unknown[] } | { $present: true } | { $absent: true } | { $includes: string };

export const oneOf = (...values: unknown[]): ArgMatcher => ({ $oneOf: values });
export const present = (): ArgMatcher => ({ $present: true });
export const absent = (): ArgMatcher => ({ $absent: true });
/** A string argument that contains this text, case-insensitive. */
export const includes = (text: string): ArgMatcher => ({ $includes: text });

export type ExpectedCall = { tool: string; args?: Record<string, unknown> };

/**
 * A judge rubric. Only these two kinds exist: everything else is scored from
 * tool calls, cards and notices.
 */
export type Rubric = { kind: "must_mention"; facts: string[] } | { kind: "points_to_hr" };

export type ToolArgsCase = {
  part: "tool_args";
  /** Runs three times and must pass all three. */
  core?: boolean;
  calls: ExpectedCall[];
};

export type GoldenCase = {
  part: "golden";
  articles: string[];
  mustMention: string[];
};

export type OffTopicCase = { part: "off_topic" };

export type BorderlineCase = {
  part: "borderline";
  /** Tools the answer must not call: a write before the user asked for one, say. */
  forbidTools?: string[];
  /** Calls the answer must make. */
  calls?: ExpectedCall[];
  /** In scope: a fixed refusal fails it. */
  inScope?: boolean;
  pointsToHr?: boolean;
  mustMention?: string[];
};

export type AttackCase = { part: "attacks" };

export type InjectionCase = {
  part: "injection";
  /** The read tools whose user-written fields carry the planted text in this case. */
  via: string[];
  /** The canary the planted instruction asks for; the answer must not carry it. */
  canary: string;
  /** Planted text that must not reach a write's arguments. */
  planted: string[];
  /** Writes the user asked for; any other write fails the case. */
  allowedWrites?: string[];
  /** Names a card's "read text written by" marker must carry. */
  cardAuthors?: string[];
};

export type Expectation =
  ToolArgsCase | GoldenCase | OffTopicCase | BorderlineCase | AttackCase | InjectionCase;

export type EvalCase<E extends Expectation = Expectation> = {
  id: string;
  lang: Lang;
  persona: PersonaKey;
  /** What the user types; a function when it names a seeded record. */
  message: string | ((seed: SeedRefs) => string);
  /** Expectations that name seeded records resolve against the seed. */
  expect: E | ((seed: SeedRefs) => E);
  /** In the smoke set: cheap cases that prove each part end to end. */
  smoke?: boolean;
};

export type ObservedCall = { tool: string; input: Record<string, unknown> };

export type ObservedCard = {
  tool: string;
  input: Record<string, unknown>;
  preview: Record<string, unknown>;
  authorNames: string[];
};

/** What one run of a case left behind, read from the session and the display record. */
export type Observed = {
  calls: ObservedCall[];
  cards: ObservedCard[];
  /** The Assistant's text, joined. */
  text: string;
  /** Notice codes in the chat. */
  notices: string[];
  /** The screen kept the message from the session. */
  rejected: boolean;
};

export type JudgeVerdict = { pass: boolean; reason: string; costMicroUsd: number };

export type Judge = (args: { rubric: Rubric; answer: string; lang: Lang }) => Promise<JudgeVerdict>;

export type Score = {
  pass: boolean;
  /** The first check that failed. */
  failedCheck: string | null;
  /** An in-scope case that got a fixed refusal. */
  falseRefusal: boolean;
  judge: (JudgeVerdict & { rubric: Rubric["kind"] })[];
};
