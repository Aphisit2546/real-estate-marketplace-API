import { deactivateSchema } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { deactivateAccount } from '@/modules/users/users.service';

export const POST = route({ auth: 'required', body: deactivateSchema }, async ({ actor, ip }) => {
  await deactivateAccount(actor, ip);
  return noContent();
});
