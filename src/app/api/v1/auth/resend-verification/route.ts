import { forgotPasswordSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { resendVerification } from '@/modules/auth/auth.service';

export const POST = route(
  { body: forgotPasswordSchema, rateLimit: { name: 'resend', max: 5, windowSeconds: 3600, by: 'ip' } },
  async ({ body }) => {
    await resendVerification(body.email, body.redirectTo);
    return ok({ sent: true });
  },
);
