import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { unauthorized } from '@/lib/errors';
import { ok, route } from '@/lib/http';
import { expireListings } from '@/modules/listings/listings.service';

function isAuthorized(header: string | null): boolean {
  const secret = env().CRON_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export const POST = route({}, async ({ req }) => {
  if (!isAuthorized(req.headers.get('authorization'))) throw unauthorized();
  return ok({ expired: await expireListings() });
});

// Vercel Cron issues GET requests. It sends CRON_SECRET the same way, so the check is identical.
export const GET = POST;
