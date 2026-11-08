import { absent, includes, oneOf, type EvalCase, type ToolArgsCase } from "../types.js";

type Case = EvalCase<ToolArgsCase>;

/** Today in every case is Wednesday 2027-03-10. */
export const TOOL_ARGS_CS: Case[] = [
  {
    id: "tool_args.cs.balances",
    lang: "cs",
    persona: "member",
    smoke: true,
    message: "Kolik dní dovolené mi letos ještě zbývá?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "get_my_balances", args: { year: oneOf(2027, undefined) } }],
    },
  },
  {
    id: "tool_args.cs.my_requests_march",
    lang: "cs",
    persona: "member",
    message: "Ukaž mi moje žádosti na březen.",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_my_requests", args: { from: "2027-03-01", to: "2027-03-31" } }],
    },
  },
  {
    id: "tool_args.cs.away_next_week",
    lang: "cs",
    persona: "member",
    message: "Kdo je příští týden pryč?",
    expect: {
      part: "tool_args",
      calls: [
        {
          tool: "list_who_is_away",
          args: { from: "2027-03-15", to: oneOf("2027-03-19", "2027-03-21") },
        },
      ],
    },
  },
  {
    id: "tool_args.cs.attendance_now",
    lang: "cs",
    persona: "member",
    message: "Běží mi teď docházka?",
    expect: { part: "tool_args", calls: [{ tool: "get_my_attendance" }] },
  },
  {
    id: "tool_args.cs.worked_february",
    lang: "cs",
    persona: "member",
    message: "Kolik hodin jsem odpracovala v únoru?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "get_my_worked_time", args: { year: oneOf(2027, undefined), month: 2 } }],
    },
  },
  {
    id: "tool_args.cs.events_april",
    lang: "cs",
    persona: "member",
    message: "Jaké týmové akce máme v dubnu?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_group_events", args: { year: oneOf(2027, undefined), month: 4 } }],
    },
  },
  {
    id: "tool_args.cs.birthdays_this_month",
    lang: "cs",
    persona: "member",
    message: "Kdo má tento měsíc narozeniny?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_birthdays", args: { month: oneOf(3, undefined), groupId: absent() } }],
    },
  },
  {
    id: "tool_args.cs.directory_find",
    lang: "cs",
    persona: "member",
    message: "Najdi Carla ve firemním adresáři.",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_directory_people", args: { search: includes("carl") } }],
    },
  },
  {
    id: "tool_args.cs.directory_profile",
    lang: "cs",
    persona: "member",
    message: "Jakou pracovní pozici má Carl Colleague?",
    expect: (seed) => ({
      part: "tool_args",
      calls: [
        { tool: "get_directory_profile", args: { employmentId: seed.employments.colleague } },
      ],
    }),
  },
  {
    id: "tool_args.cs.directory_contacts",
    lang: "cs",
    persona: "owner",
    message: "Ukaž mi nouzové kontakty Carla Colleague.",
    expect: (seed) => ({
      part: "tool_args",
      calls: [
        {
          tool: "show_directory_section",
          args: { employmentId: seed.employments.colleague, section: "contact" },
        },
      ],
    }),
  },
  {
    id: "tool_args.cs.to_approve",
    lang: "cs",
    persona: "approver",
    message: "Které žádosti čekají na moje schválení?",
    expect: { part: "tool_args", calls: [{ tool: "list_requests_to_approve" }] },
  },
  {
    id: "tool_args.cs.search_half_day",
    lang: "cs",
    persona: "member",
    message: "Vyhledej v nápovědě, jak si vzít půl dne volna.",
    expect: {
      part: "tool_args",
      calls: [{ tool: "search_docs", args: { query: includes("půl") } }],
    },
  },
  {
    id: "tool_args.cs.read_half_days",
    lang: "cs",
    persona: "member",
    message: "Otevři článek nápovědy o půldnech a časech.",
    expect: {
      part: "tool_args",
      calls: [{ tool: "read_doc", args: { id: "half-days-and-times" } }],
    },
  },
  {
    id: "tool_args.cs.book_friday",
    lang: "cs",
    persona: "member",
    message: "Zadej mi dovolenou na pátek 19. března.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "create_request",
          args: {
            from: "2027-03-19",
            to: "2027-03-19",
            type: oneOf("VACATION", undefined),
            halfDay: oneOf(false, undefined),
          },
        },
      ],
    },
  },
  {
    id: "tool_args.cs.cancel_pending",
    lang: "cs",
    persona: "member",
    message: "Zruš moji žádost na 22. a 23. března.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [{ tool: "cancel_my_request", args: { requestId: seed.requests.memberPending } }],
    }),
  },
  {
    id: "tool_args.cs.clock_in",
    lang: "cs",
    persona: "member",
    message: "Zaznamenej můj příchod do práce.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_in" }] },
  },
  {
    id: "tool_args.cs.clock_out",
    lang: "cs",
    persona: "member",
    message: "Zaznamenej můj odchod, pro dnešek končím.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_out" }] },
  },
  {
    id: "tool_args.cs.approve",
    lang: "cs",
    persona: "approver",
    message: "Schval Carlovi žádost na 15. a 16. března.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [{ tool: "approve_request", args: { requestId: seed.requests.colleaguePending } }],
    }),
  },
  {
    id: "tool_args.cs.reject",
    lang: "cs",
    persona: "approver",
    message: "Zamítni Carlovu žádost na 15. a 16. března, ten týden máme vydání.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "reject_request",
          args: { requestId: seed.requests.colleaguePending, reason: includes("vydání") },
        },
      ],
    }),
  },
];
