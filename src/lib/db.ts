import postgres from 'postgres';
import { env } from './env';

export type Tx = postgres.TransactionSql;

export interface Actor {
  id: string;
  email: string;
  roles: import('@rem/shared').AppRole[];
}

let pool: postgres.Sql | undefined;

const numeric = (oid: number) => ({
  to: oid,
  from: [oid],
  serialize: (value: number) => String(value),
  parse: (value: string) => Number(value),
});

function sql(): postgres.Sql {
  pool ??= postgres(env().DATABASE_URL, {
    // Supavisor transaction mode does not support prepared statements.
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    transform: postgres.toCamel,
    // Money fits well within Number.MAX_SAFE_INTEGER (see the CHECK limits).
    types: { bigint: numeric(20), numeric: numeric(1700) },
    onnotice: () => undefined,
  });
  return pool;
}

async function run<T>(role: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await sql().begin(async (tx) => {
    const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
    // Transaction-local, so this cannot leak to the next user of a pooled connection.
    await tx`select set_config('role', ${role}, true), set_config('request.jwt.claims', ${claims}, true)`;
    return fn(tx);
  });
  return result as T;
}

/** Public reads, subject to RLS. */
export const withAnon = <T>(fn: (tx: Tx) => Promise<T>) => run('anon', null, fn);

/** A signed-in user's work, subject to RLS. */
export const withUser = <T>(actor: Actor, fn: (tx: Tx) => Promise<T>) => run('authenticated', actor.id, fn);

export const withActor = <T>(actor: Actor | null, fn: (tx: Tx) => Promise<T>) =>
  actor ? withUser(actor, fn) : withAnon(fn);

/**
 * Bypasses RLS. Only call after the service layer has authorized the operation.
 * `actorId` is kept in the claims so history triggers record who did it.
 */
export const withService = <T>(actorId: string | null, fn: (tx: Tx) => Promise<T>) =>
  run('service_role', actorId, fn);
