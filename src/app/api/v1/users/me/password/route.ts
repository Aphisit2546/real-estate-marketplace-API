import { changePasswordSchema } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { changePassword } from '@/modules/auth/auth.service';

export const POST = route(
  { auth: 'required', body: changePasswordSchema, rateLimit: { name: 'password', max: 5, windowSeconds: 900 } },
  async ({ actor, body }) => {
    await changePassword(actor, body.currentPassword, body.newPassword);
    return noContent();
  },
);
