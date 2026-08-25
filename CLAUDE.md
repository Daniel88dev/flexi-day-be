# CLAUDE.md

Guidance for Claude Code working in `flexi-day-be`, the Express 5 + TypeScript + Drizzle + Better
Auth backend for Flexi Day, a vacation management product.

## Invariants

[`docs/invariants.md`](docs/invariants.md) — read before changing auth or account linking,
`/api/dev/*`, `/api/support/*`, a rate limiter, or an org-admin permission check. Each entry states
what breaks if it is undone; several have tests that fail on regression.

## Domain

[`CONTEXT.md`](CONTEXT.md) — vacation workflow, group and organization structure, invites,
mirroring, quota rollover, and the schema rows that are not self-describing.

## Infrastructure

[`docs/terraform.md`](docs/terraform.md) — read before adding an environment variable, an IAM
permission, or any AWS resource. Production runs on App Runner and RDS defined in `terraform/`, so a
variable that only reaches `config.ts` and `.env` never reaches production. Secrets go in via
Secrets Manager, and the live values live in the gitignored `terraform/terraform.tfvars`.

## Imports need `.js` extensions

`"type": "module"` plus `verbatimModuleSyntax: true` means every relative import carries a `.js`
extension, even when the source is `.ts`:

```typescript
import { auth } from "../utils/auth.js";
```

## Layout

`src/routes/` define endpoints → `src/controllers/` handle request/response → `src/services/` hold
business logic and database access → `src/db/` is the Drizzle schema and client. `src/index.ts`
creates the server and handles graceful shutdown; `src/server.ts` assembles middleware and routes.

Those arrows run one way. `src/services/` imports nothing from `src/controllers/`, which is why the
permission guards live in the services layer rather than beside the handlers that call them:
`vacation/decisionGuards.ts` and `vacation/vacationPermissions.ts` for who may decide or cancel a
booking, `groupUser/groupAccess.ts` for standing in a group, `billing/guards.ts` for whether a
group's plan still allows writes. Controllers import them; so does the transition module, which
could not if they had stayed a layer up.

`src/jobs/` schedules background work with croner, started from `src/index.ts` and stopped on
shutdown. Job modules only schedule and log — the work itself lives in a service, so it stays
callable and testable outside the timer.

## Database access imports the service module

Each domain lives in `src/services/{domain}/` as `{domain}Services.ts` plus a `types.ts` holding
its TypeScript types and Zod schemas. A domain splits into more than one service module when it
carries a concept with its own lifecycle — `groupUser/` holds `inviteLinkServices.ts` beside
`groupUserServices.ts`. Callers import the functions they need by name:

```typescript
import { getGroup, getApprovalUsers } from "../../services/group/groupServices.js";
```

There is no registry, container or injected `services` object in between, and adding one back
needs [`docs/adr/0001-no-service-registry.md`](docs/adr/0001-no-service-registry.md) read first.
A unit test mocks the module the code under test imports, by path — see
`src/services/billing/tests/guards.test.ts`.

Two rules hold for every write, wherever its transaction is opened. Anything that appends a
`vacation_events` row belongs in the same transaction as the change it records. Notifications go
out after the commit, never inside it.

**For the seven vacation transitions, the transition module owns the boundary.** Approve, reject,
cancel and comment, in their single and bulk forms, open no transaction of their own. They call
`src/services/vacation/vacationTransitions.ts`, which runs the whole sequence in one place: load,
authorize, plan guard, quota guard, mutate, lost-race check, event append, commit, then notify. The
two rules above therefore hold by construction rather than by each route remembering them. A
transition supplies only what differs, its load, its authorization, its mutation and its own
not-found and conflict wording, and its controller is left parsing the request and shaping the
response. Reach for the module for any new vacation state change.

**Every other write handler owns its own boundary.** It imports `db`, opens
`db.transaction(async (tx) => ...)`, and threads that `tx` through every service call and guard
inside it, so the whole request commits or rolls back together:

```typescript
const quota = await db.transaction(async (tx) => {
  await assertGroupAdmin(auth.userId, groupId, tx);
  await assertGroupWritable(groupId, tx);
  return upsertUserYearQuota(payload, tx);
});
```

## Migrations

**In progress:** [`docs/better-auth-1.7-migration.md`](docs/better-auth-1.7-migration.md) — the 1.7
upgrade re-keys the `account` table and needs a maintenance window with a specific deploy order
(App Runner will not pick up the new image on resume by itself). Read it before deploying or
migrating anything auth-related, and delete it once production is on 1.7.

`npm run db:generate` writes a new file into `src/db/schema/out/`. `scripts/db-migrate.sh` applies
it, and its header documents every flag.

**Apply migrations to local databases. Hand every production migration to the user.** Write the
migration, apply it locally, confirm the app still works, then give the user the exact command and
stop. The prod target refuses to start unless stdin is a terminal, so an agent shell cannot put DDL
on the live database even by accident, and `--yes` does not get around it.

| Command                    | Target                                         | Who runs it             |
| -------------------------- | ---------------------------------------------- | ----------------------- |
| `npm run db:migrate:local` | the `DATABASE` in `.env`                       | anyone                  |
| `npm run db:status:prod`   | prints the applied ledger, writes nothing      | anyone                  |
| `npm run db:baseline:prod` | records a squashed baseline as applied, no DDL | the user, at a terminal |
| `npm run db:migrate:prod`  | RDS, connection string from Secrets Manager    | the user, at a terminal |

The prod target pins the RDS CA bundle and connects with `sslmode=verify-full`. The connection
string is never printed and never passed as a command-line argument, where `ps` would hand it to
every other local user; psql gets the parts through libpq's `PG*` variables.

`--baseline` is for the other kind of ledger drift: a squashed history, where the database ran the
original migrations and `0000_init` has since been rewritten to stand for all of them. Drizzle
compares only the newest ledger row, so it would replay the baseline over a live schema and fail on
the first `CREATE TYPE ... already exists`. `--baseline` records it as applied instead. It refuses
on a database with no `account` table, where the baseline is a real migration that has to run.

`--reset` drops the schema, the data and the ledger, then migrates from scratch. On prod it demands
the typed phrase even with `--yes`, because unattended is never the right way to drop a production
database. Reach for it on a local database whose ledger has drifted from the migration files.

## Route conventions

A protected route composes `authSession` → `bodyValidationMiddleware(schema)` → `tryCatch(handler)`,
with the Zod schema imported from that domain's `types.ts`. `tryCatch` forwards to `errorMiddleware`,
which turns `AppError` (`src/utils/appError.ts`: `code`, `message`, `logging`) into the JSON
response — throw `AppError` rather than writing error responses by hand.

**API docs are generated, so `@openapi` JSDoc on every route stays complete and current** — request
and response schemas, auth requirements, error codes, parameter validation. Follow
`src/routes/vacationRouter.ts`.

## Testing

- Unit: `src/**/*.test.ts`, run with `npm test`. Mock database calls and test the logic.
- E2E: `src/**/*.e2e.test.ts`, run with `npm run test:e2e` — it checks the DB connection first
  (`src/tests/e2e/check-db.ts`) and reads `.env.e2e.test`. Real database, helpers in
  `src/tests/e2e/helpers/`, and each test cleans up after itself. `npm run docker:e2e:run` runs
  the suite against a containerised Postgres, as CI does.

## Configuration

`src/config.ts` parses and validates every environment variable, and throws at startup when one is
missing or invalid. Read it rather than a list here. Three blocks are opt-in and stay that way:
`DEV_TOOLS_*`, `SUPPORT_ADMIN_USER_IDS`, and `PADDLE_*` — see [`docs/invariants.md`](docs/invariants.md).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, reached with the `gh` CLI. See
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical triage roles, each label string equal to its name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](docs/agents/domain.md).
