import type { AppRole, UserStatus } from '@rem/shared';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { withService, type Actor } from './db';
import { env } from './env';
import { forbidden, unauthorized } from './errors';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function verifyJwt(token: string): Promise<JWTPayload> {
  const { SUPABASE_URL, SUPABASE_JWT_SECRET } = env();
  const options = { audience: 'authenticated', issuer: `${SUPABASE_URL}/auth/v1` };
  if (SUPABASE_JWT_SECRET) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SUPABASE_JWT_SECRET), {
      ...options,
      algorithms: ['HS256'],
    });
    return payload;
  }
  jwks ??= createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, { ...options, algorithms: ['ES256', 'RS256'] });
  return payload;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  return header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
}

/**
 * Identity comes from the verified token; status and roles come from the database
 * on every request, so suspension and role changes apply immediately.
 */
export async function authenticate(req: Request): Promise<Actor | null> {
  const token = bearerToken(req);
  if (!token) return null;

  let payload: JWTPayload;
  try {
    payload = await verifyJwt(token);
  } catch {
    throw unauthorized('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'INVALID_TOKEN');
  }
  if (!payload.sub) throw unauthorized('เซสชันไม่ถูกต้อง', 'INVALID_TOKEN');
  const userId = payload.sub;

  const row = await withService(null, async (tx) => {
    const [profile] = await tx<{ status: UserStatus; roles: AppRole[] }[]>`
      select p.status, coalesce(array_agg(r.role::text) filter (where r.role is not null), '{}') as roles
      from public.profiles p
      left join public.user_roles r on r.user_id = p.id
      where p.id = ${userId}
      group by p.id`;
    return profile;
  });

  if (!row) throw unauthorized('ไม่พบบัญชีผู้ใช้', 'INVALID_TOKEN');
  if (row.status !== 'active') throw forbidden('บัญชีนี้ถูกระงับการใช้งาน', 'ACCOUNT_SUSPENDED');

  return { id: userId, email: typeof payload.email === 'string' ? payload.email : '', roles: row.roles };
}
