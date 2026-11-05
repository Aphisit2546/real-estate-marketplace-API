import { idParam } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { listingStats } from '@/modules/listings/listings.service';

export const GET = route({ auth: 'required', role: 'lister', params: idParam }, async ({ actor, params }) =>
  ok(await listingStats(actor, params.id)));
