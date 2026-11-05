import { becomeListerSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { becomeLister } from '@/modules/users/users.service';

export const POST = route({ auth: 'required', body: becomeListerSchema }, async ({ actor, body, ip }) =>
  ok(await becomeLister(actor, body.role, ip)));
