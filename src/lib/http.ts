import { isAdmin, isLister } from '@rem/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate } from './auth';
import { withService, type Actor } from './db';
import { env } from './env';
import { ApiError, forbidden, fromDatabaseError, rateLimited, unauthorized, unprocessable } from './errors';

interface RateLimit {
  name: string;
  max: number;
  windowSeconds: number;
  /** Defaults to the user when signed in, otherwise the client IP. */
  by?: 'ip' | 'user';
}

interface Options<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> {
  auth?: 'public' | 'optional' | 'required';
  role?: 'lister' | 'admin';
  params?: P;
  query?: Q;
  body?: B;
  rateLimit?: RateLimit;
}

type Inferred<T> = T extends z.ZodType ? z.output<T> : undefined;

interface Context<P, Q, B, A> {
  req: NextRequest;
  actor: A;
  params: Inferred<P>;
  query: Inferred<Q>;
  body: Inferred<B>;
  ip: string;
}

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

export function ok<T>(data: T, init: { status?: number; meta?: unknown } = {}): NextResponse {
  return NextResponse.json(
    init.meta === undefined ? { data } : { data, meta: init.meta },
    { status: init.status ?? 200 },
  );
}

export const created = <T>(data: T) => ok(data, { status: 201 });
export const noContent = () => new NextResponse(null, { status: 204 });

export function clientIp(req: Request): string {
  const secret = env().INTERNAL_PROXY_SECRET;
  if (secret && req.headers.get('x-internal-proxy-secret') === secret) {
    const forwarded = req.headers.get('x-client-ip');
    if (forwarded) return forwarded;
  }
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? '0.0.0.0';
}

function validationError(error: z.ZodError) {
  const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  return unprocessable(details[0]?.message ?? 'ข้อมูลไม่ถูกต้อง', 'VALIDATION_ERROR', details);
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function toResponse(error: unknown): NextResponse {
  const apiError = error instanceof ApiError ? error : fromDatabaseError(error);
  if (apiError) {
    return NextResponse.json(
      { error: { code: apiError.code, message: apiError.message, details: apiError.details } },
      { status: apiError.status },
    );
  }
  // Only the message is logged: request bodies can contain passwords or tokens.
  console.error('Unhandled API error:', error instanceof Error ? error.message : 'unknown');
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' } },
    { status: 500 },
  );
}

function queryObject(req: NextRequest): Record<string, string> {
  return Object.fromEntries(req.nextUrl.searchParams.entries());
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw unprocessable('รูปแบบข้อมูลไม่ถูกต้อง', 'INVALID_JSON');
  }
}

async function enforceRateLimit(limit: RateLimit, actor: Actor | null, ip: string) {
  const subject = limit.by === 'ip' || !actor ? ip : actor.id;
  const allowed = await withService(null, async (tx) => {
    const key = `${limit.name}:${subject}`;
    const [row] = await tx<{ allowed: boolean }[]>`
      select public.rate_limit_hit(${key}, ${limit.max}, ${limit.windowSeconds}) as allowed`;
    return row?.allowed ?? false;
  });
  if (!allowed) throw rateLimited();
}

type Handler<P, Q, B, A> = (ctx: Context<P, Q, B, A>) => Promise<Response> | Response;

export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(
  options: Options<NonNullable<P> & z.ZodType, NonNullable<Q> & z.ZodType, NonNullable<B> & z.ZodType> & {
    auth: 'required';
    params?: P;
    query?: Q;
    body?: B;
  },
  handler: Handler<P, Q, B, Actor>,
): (req: NextRequest, ctx: RouteContext) => Promise<Response>;
export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(
  options: Options<NonNullable<P> & z.ZodType, NonNullable<Q> & z.ZodType, NonNullable<B> & z.ZodType> & {
    auth?: 'public' | 'optional';
    params?: P;
    query?: Q;
    body?: B;
  },
  handler: Handler<P, Q, B, Actor | null>,
): (req: NextRequest, ctx: RouteContext) => Promise<Response>;
export function route(
  options: Options<z.ZodType, z.ZodType, z.ZodType>,
  handler: Handler<z.ZodType, z.ZodType, z.ZodType, never>,
) {
  return async (req: NextRequest, routeContext: RouteContext): Promise<Response> => {
    try {
      const mode = options.auth ?? 'public';
      const actor = mode === 'public' ? null : await authenticate(req);
      if (mode === 'required' && !actor) throw unauthorized();
      if (options.role === 'admin' && !(actor && isAdmin(actor.roles))) throw forbidden();
      if (options.role === 'lister' && !(actor && isLister(actor.roles))) {
        throw forbidden('กรุณาลงทะเบียนเป็นผู้ประกาศก่อน', 'NOT_A_LISTER');
      }

      const ip = clientIp(req);
      if (options.rateLimit) await enforceRateLimit(options.rateLimit, actor, ip);

      const params = options.params ? parse(options.params, await routeContext.params) : undefined;
      const query = options.query ? parse(options.query, queryObject(req)) : undefined;
      const body = options.body ? parse(options.body, await readJson(req)) : undefined;

      return await handler({ req, actor, params, query, body, ip } as never);
    } catch (error) {
      return toResponse(error);
    }
  };
}
