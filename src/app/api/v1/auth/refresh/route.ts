import { refreshSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { refresh } from '@/modules/auth/auth.service';

export const POST = route(
  { body: refreshSchema, rateLimit: { name: 'refresh', max: 60, windowSeconds: 300, by: 'ip' } },
  async ({ body }) => ok(await refresh(body.refreshToken)),
);
