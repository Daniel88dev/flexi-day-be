import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestListener } from "node:http";
import type { Express } from "express";
import type { Pool, PoolClient, QueryConfig } from "pg";
import { db } from "../../../db/db.js";

const scope = new AsyncLocalStorage<string[]>();
let installed = false;

const textOf = (query: unknown): string =>
  typeof query === "string" ? query : ((query as QueryConfig | undefined)?.text ?? String(query));

const record = (query: unknown) => scope.getStore()?.push(textOf(query));

const countingClient = (client: PoolClient): PoolClient =>
  new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return (...args: Parameters<PoolClient["query"]>) => {
          record(args[0]);
          return (target.query as (...rest: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/**
 * Wraps the pool behind the app's drizzle instance once per test file. Only
 * queries issued inside a {@link countQueries} scope are recorded, so setup
 * reads and anything else sharing the pool never reach the count.
 */
const install = () => {
  if (installed) return;
  installed = true;

  const pool = (db as unknown as { $client: Pool }).$client;

  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.query = ((...args: unknown[]) => {
    record(args[0]);
    return query(...args);
  }) as Pool["query"];

  // Drizzle opens a transaction by checking a client out with the promise form.
  // `pool.query` checks one out with the callback form and is already counted.
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  pool.connect = ((...args: unknown[]) => {
    if (args.length > 0) return connect(...args);
    return (connect() as Promise<PoolClient>).then(countingClient);
  }) as Pool["connect"];
};

/**
 * The SQL one request sends, in order. `send` gets a listener that serves the
 * app inside the counting scope; hand it to supertest in place of the app.
 */
export const countQueries = async <T>(
  app: Express,
  send: (counted: RequestListener) => PromiseLike<T>
): Promise<{ result: T; queries: string[] }> => {
  install();
  const queries: string[] = [];
  const counted: RequestListener = (req, res) => scope.run(queries, () => app(req, res));
  const result = await send(counted);
  return { result, queries };
};
