import { updateProfileSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { getCurrentUser, updateProfile } from '@/modules/users/users.service';

export const GET = route({ auth: 'required' }, async ({ actor }) => ok(await getCurrentUser(actor)));
export const PATCH = route({ auth: 'required', body: updateProfileSchema }, async ({ actor, body }) =>
  ok(await updateProfile(actor, body)));
