import { absent, includes, oneOf, present, type EvalCase, type ToolArgsCase } from "../types.js";

type Case = EvalCase<ToolArgsCase>;

/** Today in every case is Wednesday 2027-03-10; the English file says why March 29 is avoided. */
export const TOOL_ARGS_CS: Case[] = [
  {
    id: "tool_args.cs.balances",
    lang: "cs",
    persona: "member",
    smoke: true,
    message: "Kolik dní dovolené mi letos ještě zbývá?",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "get_my_balances", args: { year: oneOf(2027, undefined) } }],
    },
  },
  {
    id: "tool_args.cs.balances_last_year",
    lang: "cs",
    persona: "member",
    message: "Kolik dovolené jsem měla v roce 2026?",
    expect: { part: "tool_args", calls: [{ tool: "get_my_balances", args: { year: 2026 } }] },
  },
  {
    id: "tool_args.cs.my_requests_march",
    lang: "cs",
    persona: "member",
    message: "Ukaž mi moje žádosti na březen.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "list_my_requests", args: { from: "2027-03-01", to: "2027-03-31" } }],
    },
  },
  {
    id: "tool_args.cs.my_requests_cancelled",
    lang: "cs",
    persona: "member",
    message: "Vypiš moje letošní žádosti, i ty zrušené.",
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
    id: "tool_args.cs.away_next_week",
    lang: "cs",
    persona: "member",
    message: "Kdo je příští týden pryč?",
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
    id: "tool_args.cs.away_friday",
    lang: "cs",
    persona: "member",
    message: "Má někdo tento pátek volno?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_who_is_away", args: { from: "2027-03-12", to: "2027-03-12" } }],
    },
  },
  {
    id: "tool_args.cs.attendance_now",
    lang: "cs",
    persona: "member",
    message: "Běží mi teď docházka?",
    expect: { part: "tool_args", core: true, calls: [{ tool: "get_my_attendance" }] },
  },
  {
    id: "tool_args.cs.attendance_started",
    lang: "cs",
    persona: "colleague",
    message: "V kolik jsem dnes začal pracovat?",
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
    id: "tool_args.cs.worked_this_month",
    lang: "cs",
    persona: "member",
    message: "Nemám tento měsíc málo odpracovaných hodin?",
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
    id: "tool_args.cs.events_april",
    lang: "cs",
    persona: "member",
    message: "Jaké týmové akce máme v dubnu?",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "list_group_events", args: { year: oneOf(2027, undefined), month: 4 } }],
    },
  },
  {
    id: "tool_args.cs.events_this_month",
    lang: "cs",
    persona: "admin",
    message: "Máme tento měsíc v týmu něco naplánovaného?",
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
    id: "tool_args.cs.birthdays_june",
    lang: "cs",
    persona: "member",
    message: "Slaví někdo narozeniny v červnu?",
    expect: { part: "tool_args", calls: [{ tool: "list_birthdays", args: { month: 6 } }] },
  },
  {
    id: "tool_args.cs.directory_find",
    lang: "cs",
    persona: "member",
    message: "Najdi Carla ve firemním adresáři.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "list_directory_people", args: { search: includes("carl") } }],
    },
  },
  {
    id: "tool_args.cs.directory_everyone",
    lang: "cs",
    persona: "member",
    message: "Kdo všechno u nás pracuje? Vypiš celý adresář.",
    expect: {
      part: "tool_args",
      calls: [{ tool: "list_directory_people", args: { search: absent() } }],
    },
  },
  {
    id: "tool_args.cs.directory_profile",
    lang: "cs",
    persona: "member",
    message: "Jaký je pracovní e-mail Carla Colleague?",
    expect: (seed) => ({
      part: "tool_args",
      calls: [
        { tool: "get_directory_profile", args: { employmentId: seed.employments.colleague } },
      ],
    }),
  },
  {
    id: "tool_args.cs.directory_profile_any",
    lang: "cs",
    persona: "member",
    message: "Kdo je nadřízený Carla Colleague?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "get_directory_profile", args: { employmentId: present() } }],
    },
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
    id: "tool_args.cs.directory_private_phone",
    lang: "cs",
    persona: "owner",
    message: "Potřebuji soukromé telefonní číslo Carla Colleague.",
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
    expect: { part: "tool_args", core: true, calls: [{ tool: "list_requests_to_approve" }] },
  },
  {
    id: "tool_args.cs.to_approve_short",
    lang: "cs",
    persona: "approver",
    message: "Mám něco ke schválení?",
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
    id: "tool_args.cs.search_calendar_feed",
    lang: "cs",
    persona: "member",
    message: "Podívej se do nápovědy: jak dostanu svoje volno do Google Kalendáře?",
    expect: {
      part: "tool_args",
      calls: [{ tool: "search_docs", args: { query: includes("kalend") } }],
    },
  },
  {
    id: "tool_args.cs.read_half_days",
    lang: "cs",
    persona: "member",
    message: "Otevři článek nápovědy o půldnech a časech.",
    expect: {
      part: "tool_args",
      core: true,
      calls: [{ tool: "read_doc", args: { id: "half-days-and-times" } }],
    },
  },
  {
    id: "tool_args.cs.read_birthdays",
    lang: "cs",
    persona: "member",
    message: "Ukaž mi článek nápovědy o narozeninách.",
    expect: { part: "tool_args", calls: [{ tool: "read_doc", args: { id: "birthdays" } }] },
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
    id: "tool_args.cs.book_week",
    lang: "cs",
    persona: "member",
    message: "Zadej mi dovolenou od pondělí 5. dubna do pátku 9. dubna.",
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
    id: "tool_args.cs.book_home_office_tomorrow",
    lang: "cs",
    persona: "member",
    message: "Zítra budu pracovat z domova, zapiš mi to prosím.",
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
    id: "tool_args.cs.book_half_day",
    lang: "cs",
    persona: "member",
    message: "Potřebuji volné dopoledne v úterý 30. března.",
    expect: {
      part: "tool_args",
      calls: [
        { tool: "create_request", args: { from: "2027-03-30", to: "2027-03-30", halfDay: true } },
      ],
    },
  },
  {
    id: "tool_args.cs.book_home_office_second_team",
    lang: "cs",
    persona: "multiGroup",
    message: "Zadej mi home office ve čtvrtek 25. března ve skupině Second Team.",
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
    id: "tool_args.cs.cancel_approved",
    lang: "cs",
    persona: "member",
    message: "Tenhle pátek už volno nepotřebuji, zruš ho.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [{ tool: "cancel_my_request", args: { requestId: seed.requests.memberApproved } }],
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
    id: "tool_args.cs.clock_in_starting",
    lang: "cs",
    persona: "member",
    message: "Právě začínám pracovat.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_in" }] },
  },
  {
    id: "tool_args.cs.clock_out",
    lang: "cs",
    persona: "colleague",
    message: "Zaznamenej můj odchod, pro dnešek končím.",
    expect: { part: "tool_args", core: true, calls: [{ tool: "clock_out" }] },
  },
  {
    id: "tool_args.cs.clock_out_heading_home",
    lang: "cs",
    persona: "colleague",
    message: "Jdu domů, ukonči mi docházku.",
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
    id: "tool_args.cs.approve_by_name",
    lang: "cs",
    persona: "approver",
    message: "Čekající dovolená Carla Colleague je v pořádku, schval ji.",
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
  {
    id: "tool_args.cs.reject_short_staffed",
    lang: "cs",
    persona: "approver",
    message: "Zamítni čekající žádost Carla Colleague. Důvod: nemáme dost lidí.",
    expect: (seed) => ({
      part: "tool_args",
      core: true,
      calls: [
        {
          tool: "reject_request",
          args: { requestId: seed.requests.colleaguePending, reason: includes("lid") },
        },
      ],
    }),
  },
];
