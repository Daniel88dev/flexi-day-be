# Unit tests refuse query execution, not database access

Unit CI carries no database, so a unit test that reaches one fails with a drizzle
`Failed query` dump over an `ECONNREFUSED` `AggregateError` from `pg-pool`. On a laptop
with Postgres up it is worse: the same test quietly passes against the dev database.
Neither outcome says which module to mock. A `setupFiles` guard on the unit config makes
the failure local, immediate and self-explaining.

The guard refuses **execution**, not access. It intercepts `then` on the builder the `db`
export returns, and `transaction` at its call site. Both are entered synchronously from
the calling module, so the error can name the module to mock. `execute` and `$count` are
thenables and need no case of their own. A patch over `pg.Pool.prototype.connect` and
`query` sits underneath as a backstop for code that reaches `pool` directly, with a weaker
message that cannot name the caller.

`transaction` carries this repo's database access: 98 call sites against one `db.execute`
and one `db.$count`, with every other `execute` on a `tx` already inside a transaction. A
guard that named modules for plain selects but not for transactions would miss almost
everything worth naming.

## Considered options

**Throwing on any `db` method.** Rejected, because it cannot tell composing SQL from
running it. The attachment retention service calls `db.select()` at module scope to build
a `notExists` fragment that never executes and needs no connection, so this option fails
three test files on import.

**Patching `pg.Pool.prototype` alone.** Rejected as the primary layer, kept as the
backstop. It is free and catches everything, but by the time `connect` fires the calling
module is across an await boundary and gone from the stack. Raising
`Error.stackTraceLimit` to 200 confirms it: the trace bottoms out at `PgSelectBase.then`.
It can only report that a query happened, never where from.

## Consequences

The primary layer reads drizzle's builder protocol, which a major version may move. If it
does, the guard degrades silently: queries still fail, but through the backstop, without
naming a module. The backstop's message says so explicitly and points here.

The guard therefore has a test of its own: a fixture that executes a query, asserted to
fail with a message naming the fixture. On a drizzle upgrade, repair that test rather than
delete it. Deleted, the degradation above has nothing left to announce it.

The 28 unit files that already mock `src/db/db.js` by path are unaffected, because a
per-file `vi.mock` takes precedence over one registered in a setup file.

No opt-out. Nothing in the unit suite wants a real client, and `.e2e.test.ts` already
exists for tests that do.
