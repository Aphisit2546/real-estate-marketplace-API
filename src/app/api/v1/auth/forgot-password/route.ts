import { forgotPasswordSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { forgotPassword } from '@/modules/auth/auth.service';

export const POST = route(
  { body: forgotPasswordSchema, rateLimit: { name: 'forgot', max: 5, windowSeconds: 3600, by: 'ip' } },
  async ({ body }) => {
    await forgotPassword(body.email, body.redirectTo);
    return ok({ sent: true });
  },
);
