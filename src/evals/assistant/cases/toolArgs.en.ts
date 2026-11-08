import { absent, oneOf, includes, present, type EvalCase, type ToolArgsCase } from "../types.js";

type Case = EvalCase<ToolArgsCase>;

/**
 * Today in every case is Wednesday 2027-03-10. Easter Monday (March 29) is a
 * Czech holiday, so no booking case lands on it.
 */
export const TOOL_ARGS_EN: Case[] = [
  {
    id: "tool_args.en.balances",
    lang: "en",
    persona: "member",
    smoke: true,
    message: "How many vacation days do I have left this year?",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "get_my_balances", args: { year: oneOf(2027, undefined) } }],
    },
  },
  {
    id: "tool_args.en.balances_last_year",
    lang: "en",
    persona: "member",
    message: "How much vacation did I have in 2026?",
    expect: { part: "tool_args", calls: [{ tool: "get_my_balances", args: { year: 2026 } }] },
  },
  {
    id: "tool_args.en.my_requests_march",
    lang: "en",
    persona: "member",
    message: "Show me my requests for March.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "list_my_requests", args: { from: "2027-03-01", to: "2027-03-31" } }],
    },
  },
  {
    id: "tool_args.en.my_requests_cancelled",
    lang: "en",
    persona: "member",
    message: "List my requests this year, including the ones I cancelled.",
    expect: {
      part: "tool_args",
      calls: [
        {
          tool: "list_my_requests",
          args: { from: "2027-01-01", to: "2027-12-31", includeCancelled: true },
        },
      ],
    },
  },
  {
    id: "tool_args.en.away_next_week",
    lang: "en",
    persona: "member",
    message: "Who is away next week?",
    expect: {
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "list_who_is_away",
          args: { from: "2027-03-15", to: oneOf("2027-03-19", "2027-03-21") },
        },
      ],
    },
  },
  {
    id: "tool_args.en.away_friday",
    lang: "en",
    persona: "member",
    message: "Is anyone off this Friday?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_who_is_away", args: { from: "2027-03-12", to: "2027-03-12" } }],
    },
  },
  {
    id: "tool_args.en.attendance_now",
    lang: "en",
    persona: "member",
    message: "Am I clocked in right now?",
    expect: { part: "tool_args", core: true, calls: [{ tool: "get_my_attendance" }] },
  },
  {
    id: "tool_args.en.attendance_breaks",
    lang: "en",
    persona: "colleague",
    message: "When did I start work today?",
    expect: { part: "tool_args", calls: [{ tool: "get_my_attendance" }] },
  },
  {
    id: "tool_args.en.worked_february",
    lang: "en",
    persona: "member",
    message: "How many hours did I work in February?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "get_my_worked_time", args: { year: oneOf(2027, undefined), month: 2 } }],
    },
  },
  {
    id: "tool_args.en.worked_this_month",
    lang: "en",
    persona: "member",
    message: "Am I behind on my hours this month?",
    expect: {
      part: "tool_args",
      calls: [
        {
          tool: "get_my_worked_time",
          args: { year: oneOf(2027, undefined), month: oneOf(3, undefined) },
        },
      ],
    },
  },
  {
    id: "tool_args.en.events_april",
    lang: "en",
    persona: "member",
    message: "What team events are there in April?",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "list_group_events", args: { year: oneOf(2027, undefined), month: 4 } }],
    },
  },
  {
    id: "tool_args.en.events_this_month",
    lang: "en",
    persona: "admin",
    message: "Do we have anything planned as a team this month?",
    expect: {
      part: "tool_args",
      calls: [
        {
          tool: "list_group_events",
          args: { year: oneOf(2027, undefined), month: oneOf(3, undefined) },
        },
      ],
    },
  },
  {
    id: "tool_args.en.birthdays_this_month",
    lang: "en",
    persona: "member",
    message: "Whose birthday is it this month?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_birthdays", args: { month: oneOf(3, undefined), groupId: absent() } }],
    },
  },
  {
    id: "tool_args.en.birthdays_june",
    lang: "en",
    persona: "member",
    message: "Does anyone have a birthday in June?",
    expect: { part: "tool_args", calls: [{ tool: "list_birthdays", args: { month: 6 } }] },
  },
  {
    id: "tool_args.en.directory_find",
    lang: "en",
    persona: "member",
    message: "Find Carl in the company directory.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "list_directory_people", args: { search: includes("carl") } }],
    },
  },
  {
    id: "tool_args.en.directory_everyone",
    lang: "en",
    persona: "member",
    message: "Who works at this company? List everyone in the directory.",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_directory_people", args: { search: absent() } }],
    },
  },
  {
    id: "tool_args.en.directory_profile",
    lang: "en",
    persona: "member",
    message: "What is Carl Colleague's work email address?",
    expect: (seed) => ({
      part: "tool_args",
      calls: [
        { tool: "get_directory_profile", args: { employmentId: seed.employments.colleague } },
      ],
    }),
  },
  {
    id: "tool_args.en.directory_profile_any",
    lang: "en",
    persona: "member",
    message: "Who does Carl Colleague report to?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "get_directory_profile", args: { employmentId: present() } }],
    },
  },
  {
    id: "tool_args.en.directory_contacts",
    lang: "en",
    persona: "owner",
    message: "Show me Carl Colleague's emergency contacts.",
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
    id: "tool_args.en.directory_private_phone",
    lang: "en",
    persona: "owner",
    message: "I need Carl Colleague's private phone number.",
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
    id: "tool_args.en.to_approve",
    lang: "en",
    persona: "approver",
    message: "Which requests are waiting for my approval?",
    expect: { part: "tool_args", core: true, calls: [{ tool: "list_requests_to_approve" }] },
  },
  {
    id: "tool_args.en.to_approve_short",
    lang: "en",
    persona: "approver",
    message: "Anything for me to sign off?",
    expect: { part: "tool_args", calls: [{ tool: "list_requests_to_approve" }] },
  },
  {
    id: "tool_args.en.search_half_day",
    lang: "en",
    persona: "member",
    message: "Search the help for booking half a day.",
    expect: {
      part: "tool_args",
      calls: [{ tool: "search_docs", args: { query: includes("half") } }],
    },
  },
  {
    id: "tool_args.en.search_calendar_feed",
    lang: "en",
    persona: "member",
    message: "Look in the help: how do I get my time off into Google Calendar?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "search_docs", args: { query: includes("calendar") } }],
    },
  },
  {
    id: "tool_args.en.read_half_days",
    lang: "en",
    persona: "member",
    message: "Open the help article about half days and times.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "read_doc", args: { id: "half-days-and-times" } }],
    },
  },
  {
    id: "tool_args.en.read_birthdays",
    lang: "en",
    persona: "member",
    message: "Show me the help article on birthdays.",
    expect: { part: "tool_args", calls: [{ tool: "read_doc", args: { id: "birthdays" } }] },
  },
  {
    id: "tool_args.en.book_friday",
    lang: "en",
    persona: "member",
    message: "Book me a vacation day on Friday the 19th.",
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
    id: "tool_args.en.book_week",
    lang: "en",
    persona: "member",
    message: "Book me vacation from Monday April 5 to Friday April 9.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "create_request",
          args: { from: "2027-04-05", to: "2027-04-09", type: oneOf("VACATION", undefined) },
        },
      ],
    },
  },
  {
    id: "tool_args.en.book_home_office_tomorrow",
    lang: "en",
    persona: "member",
    message: "I'll work from home tomorrow, please put it in.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "create_request",
          args: { from: "2027-03-11", to: "2027-03-11", type: "HOME_OFFICE" },
        },
      ],
    },
  },
  {
    id: "tool_args.en.book_half_day",
    lang: "en",
    persona: "member",
    message: "I need the morning of Tuesday March 30 off.",
    expect: {
      part: "tool_args",
      calls: [
        { tool: "create_request", args: { from: "2027-03-30", to: "2027-03-30", halfDay: true } },
      ],
    },
  },
  {
    id: "tool_args.en.book_home_office_second_team",
    lang: "en",
    persona: "multiGroup",
    message: "Book home office on Thursday March 25 in Second Team.",
    expect: (seed) => ({
      part: "tool_args",
      calls: [
        {
          tool: "create_request",
          args: {
            from: "2027-03-25",
            to: "2027-03-25",
            type: "HOME_OFFICE",
            groupId: seed.groups.second,
          },
        },
      ],
    }),
  },
  {
    id: "tool_args.en.cancel_pending",
    lang: "en",
    persona: "member",
    message: "Cancel my request for March 22 and 23.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [{ tool: "cancel_my_request", args: { requestId: seed.requests.memberPending } }],
    }),
  },
  {
    id: "tool_args.en.cancel_approved",
    lang: "en",
    persona: "member",
    message: "I don't need this Friday off any more, cancel it.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [{ tool: "cancel_my_request", args: { requestId: seed.requests.memberApproved } }],
    }),
  },
  {
    id: "tool_args.en.clock_in",
    lang: "en",
    persona: "member",
    message: "Clock me in.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_in" }] },
  },
  {
    id: "tool_args.en.clock_in_starting",
    lang: "en",
    persona: "member",
    message: "I'm starting work now.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_in" }] },
  },
  {
    id: "tool_args.en.clock_out",
    lang: "en",
    persona: "colleague",
    message: "Clock me out, I'm done for today.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_out" }] },
  },
  {
    id: "tool_args.en.clock_out_heading_home",
    lang: "en",
    persona: "colleague",
    message: "Heading home now, stop my attendance.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_out" }] },
  },
  {
    id: "tool_args.en.approve",
    lang: "en",
    persona: "approver",
    message: "Approve Carl's request for March 15 and 16.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [{ tool: "approve_request", args: { requestId: seed.requests.colleaguePending } }],
    }),
  },
  {
    id: "tool_args.en.approve_by_name",
    lang: "en",
    persona: "approver",
    message: "Carl Colleague's pending vacation is fine, approve it.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [{ tool: "approve_request", args: { requestId: seed.requests.colleaguePending } }],
    }),
  },
  {
    id: "tool_args.en.reject",
    lang: "en",
    persona: "approver",
    message: "Reject Carl's request for March 15 and 16, we have the release that week.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "reject_request",
          args: { requestId: seed.requests.colleaguePending, reason: includes("release") },
        },
      ],
    }),
  },
  {
    id: "tool_args.en.reject_short_staffed",
    lang: "en",
    persona: "approver",
    message: "Turn down Carl Colleague's pending request. Reason: we are short-staffed.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "reject_request",
          args: { requestId: seed.requests.colleaguePending, reason: includes("short") },
        },
      ],
    }),
  },
];
