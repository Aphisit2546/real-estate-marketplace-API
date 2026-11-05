import { ok, route } from '@/lib/http';
import { currentUser } from '@/modules/auth/auth.service';

export const GET = route({ auth: 'required' }, async ({ actor }) => ok(await currentUser(actor)));
