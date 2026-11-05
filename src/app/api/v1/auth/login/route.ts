import { loginSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { login } from '@/modules/auth/auth.service';

export const POST = route(
  { body: loginSchema, rateLimit: { name: 'login', max: 10, windowSeconds: 900, by: 'ip' } },
  async ({ body }) => ok(await login(body)),
);
