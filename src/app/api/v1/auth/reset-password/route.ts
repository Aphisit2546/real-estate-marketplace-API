import { resetPasswordSchema } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { setPassword } from '@/modules/auth/auth.service';

// The Bearer token here is the recovery session from the emailed link.
export const POST = route({ auth: 'required', body: resetPasswordSchema }, async ({ actor, body }) => {
  await setPassword(actor.id, body.password);
  return noContent();
});
