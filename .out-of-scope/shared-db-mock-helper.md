# A shared helper for unit-test `db` mocks

Unit test files keep their own `vi.mock` of `src/db/db.js`. There is no shared helper that
builds the stub for them.

## Why this is out of scope

Fifteen unit files stub `db` with the same one-liner, which runs the transaction callback with
an empty handle:

```ts
vi.mock("../../../db/db.js", () => ({
  db: { transaction: vi.fn((run) => run({})) },
}));
```

`vi.mock` factories are hoisted above the file's imports, so a shared helper would have to be
loaded inside the factory:

```ts
vi.mock("../../../db/db.js", async () =>
  (await import("../../../tests/mockDb.js")).transactionOnlyDb()
);
```

That is longer than the one-liner it replaces, and it puts a hop between the test and what it
stubs. The remaining files stub drizzle query chains in shapes particular to each test, which a
transaction helper would not cover.

These mocks are not redundant with the unit guard in `src/tests/noRealDatabase.ts` either. The
guard refuses every `db.transaction`, so a file that dropped its own mock would fail rather than
pass. See `docs/adr/0009-unit-tests-refuse-query-execution.md`.

Passing `{}` as the transaction handle hides little. Where a test asserts the handle's position,
it uses `expect.anything()`, `{}` or a named sentinel such as `TX`, and each of those fails when a
controller forgets to pass `tx`, because the call then has one argument fewer. Not every service
call's handle is asserted. `expect.anything()` would also not catch a controller passing `db` in
place of `tx`, but no controller does that: each passes `tx` to the services it calls inside a
transaction.

## Prior requests

- T-550: "Decide whether the 28 existing db/db.js mocks should go through the unit guard"
