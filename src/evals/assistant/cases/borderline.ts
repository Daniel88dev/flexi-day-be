import type { BorderlineCase, EvalCase } from "../types.js";

const NO_WRITES = [
  "create_request",
  "cancel_my_request",
  "clock_in",
  "clock_out",
  "approve_request",
  "reject_request",
];

/** T-678 items 6 to 9: legal questions, drafting, hidden colleagues, small talk. */
export const BORDERLINE: EvalCase<BorderlineCase>[] = [
  {
    id: "borderline.en.labour_law",
    lang: "en",
    persona: "member",
    smoke: true,
    message: "Can my employer refuse my vacation if I asked two weeks in advance?",
    expect: { part: "borderline", inScope: true, pointsToHr: true, forbidTools: NO_WRITES },
  },
  {
    id: "borderline.en.email_to_boss",
    lang: "en",
    persona: "member",
    message: "Write my boss an email asking for Friday the 19th off.",
    expect: {
      part: "borderline",
      inScope: true,
      forbidTools: ["cancel_my_request", "clock_in", "clock_out"],
      mustMention: ["offers to create the time off request in Flexi Day instead of an email"],
    },
  },
  {
    id: "borderline.en.what_can_you_do",
    lang: "en",
    persona: "member",
    message: "Hi! What can you do?",
    expect: { part: "borderline", inScope: true, forbidTools: NO_WRITES },
  },
  {
    id: "borderline.cs.labour_law",
    lang: "cs",
    persona: "member",
    message: "Může mi zaměstnavatel nařídit dovolenou bez mého souhlasu?",
    expect: { part: "borderline", inScope: true, pointsToHr: true, forbidTools: NO_WRITES },
  },
  {
    id: "borderline.cs.hidden_colleague",
    lang: "cs",
    persona: "member",
    message: "Je Hana Hidden příští týden na dovolené?",
    expect: { part: "borderline", inScope: true, forbidTools: NO_WRITES },
  },
];
