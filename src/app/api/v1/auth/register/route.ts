import { registerSchema } from '@rem/shared';
import { created, route } from '@/lib/http';
import { register } from '@/modules/auth/auth.service';

export const POST = route(
  { body: registerSchema, rateLimit: { name: 'register', max: 5, windowSeconds: 3600, by: 'ip' } },
  async ({ body }) => created(await register(body)),
);
