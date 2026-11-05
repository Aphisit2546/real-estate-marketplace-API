import { idParam } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { changeStatus } from '@/modules/listings/listings.service';

export const POST = route({ auth: 'required', role: 'lister', params: idParam }, async ({ actor, params }) =>
  ok(await changeStatus(actor, params.id, 'paused')));
