import { withAnon } from '@/lib/db';
import { ok, route } from '@/lib/http';

export const GET = route({}, async () => {
  await withAnon((tx) => tx`select 1`);
  return ok({ status: 'ok' });
});
