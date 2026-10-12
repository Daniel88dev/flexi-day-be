# Issue tracker: fenro tasks, GitHub Issues linked

Agent work lives in **fenro**, reached through the `fenro-prod` MCP server (registered at user
scope, so it loads in the workspace root and in every sub-repo). Its tools show up as
`mcp__fenro-prod__<tool>`. Tasks are named by key, like `T-12`; always say `T-12`, never a bare
number.

GitHub Issues stay open to the public and to external reporters. When a task starts from a GitHub
issue, attach the issue to the task as its source; fenro never syncs with GitHub, so read the issue
itself with `gh`. Pull requests stay on GitHub.

## Which repository a task belongs to

Every task carries `repository`, set to the repo the work belongs to. Sub-tasks inherit it from
their parent.

| Work touching                                            | `repository`                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `flexi-day/` (frontend)                                  | `Daniel88dev/flexi-day`                                                |
| `flexi-day-be/` (backend API)                            | `Daniel88dev/flexi-day-be`                                             |
| `flexi-day-emails/` (email templates)                    | `Daniel88dev/flexi-day-emails`                                         |
| `flexi-day-rn/` (iPhone app)                             | `Daniel88dev/flexi-day-rn`                                             |
| Cross-cutting                                            | The repo the work _mostly_ touches; name the others in the description |
| Workspace tooling (`tools/`, `.claude/`, `docs/agents/`) | `Daniel88dev/flexi-day-workspace`                                      |

## Conventions

- **Create a task**: `save_task` with `title`, `description`, `repository`, `labels`, and one
  `add_criteria` entry per acceptance criterion. Don't write criteria as a checklist in the
  description. `status` is `todo` by default; pass `backlog` for anything not yet triaged.
- **From a GitHub issue**: `save_task` with
  `attach: [{ url: "https://github.com/Daniel88dev/<repo>/issues/<n>", is_source: true }]`.
- **Make a task a sub-task of a parent**: `save_task` with `parent` set to the parent's key, on
  create or afterwards. When a skill says to make tickets sub-issues of their source, this is the
  operation.
- **Read a task**: `get_task` with `task: "T-12"` returns the full brief: description, criteria,
  blockers, sub-tasks, the latest handoff, decisions and recent journal.
- **List tasks**: `list_tasks` with `repository`, `labels`, `status`, `parent` or `text` filters.
  `ready: true` returns the queue an agent picks from: `todo`, unblocked, unclaimed, and no open
  sub-tasks.
- **Comment**: `add_note` with `kind` set to `note`, `decision`, `discovery` or `question`. The
  journal is append-only, so a correction is a new note.
- **Labels**: `save_task` with `add_labels` / `remove_labels`. Reuse names from `list_labels`
  before inventing new ones.
- **Block**: `blocked_by` on create, or `link_tasks` with `kind: "blocked_by"` afterwards.
- **Work a task**: `start_task` claims it and returns the brief. Then `add_note` as you go,
  `check_criterion` with evidence for each criterion, and `finish_session` with a handoff summary
  and an outcome: `done`, `in_review` (a PR is open and waits on the user), `paused`, `blocked`
  (with a `reason`) or `released`. The claim lapses after two hours without a call.
- **Found other work mid-task**: file it with `save_task` and `discovered_from` rather than doing
  it now.
- **Close without a session**: `set_status` with `done` or `cancelled`. A task can't be `done` while
  it has open sub-tasks or unchecked criteria.

Descriptions, notes and summaries are GitHub-flavoured Markdown, rendered for the user on the task
page.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if a repo treats external PRs as feature
requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a fenro task with `save_task` and set `repository` from the table above. For several
tickets, create them in dependency order so each `blocked_by` can name keys that already exist.

## When a skill says "fetch the relevant ticket"

`get_task` with the key. If the user hands you a GitHub issue URL or `repo#n` instead, look for a
task that already has it attached (`list_tasks` with `text`), and read the issue itself with
`gh -R Daniel88dev/<repo> issue view <n> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is a parent task and its tickets are sub-tasks.

- **Labels**: `wayfinder:map` on the map; `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, `wayfinder:task` on tickets. `save_task` creates any that don't exist yet.
  A map and its tickets carry no triage label such as `ready-for-agent`: they hold decisions, not
  implementation work.
- **Map**: one task labelled `wayfinder:map`, with the skill's template (Notes / Decisions so far /
  Not yet specified) as its description, and `repository` set as in the table above.
- **Child tickets**: `save_task` with `parent` set to the map's key.
- **Blocking**: `blocked_by` on create, or `link_tasks` with `kind: "blocked_by"`. fenro rejects
  cycles.
- **Claiming**: `start_task` with the ticket's key. A ticket with a live session is claimed; one
  without is not.
- **Frontier**: `list_tasks` with `parent` set to the map's key and `ready: true`.
- **Resolving**: `add_note` with `kind: "decision"`, text headed "Resolution", then
  `finish_session` with `outcome: "done"`. Then append one line to the map's "Decisions so far" by
  rewriting its description with `save_task`.
- **Out of scope**: `set_status` with `cancelled`, an `add_note` saying why, and one line in the
  map's "Out of scope" section.
