import { idParam } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { submitForReview } from '@/modules/listings/listings.service';

export const POST = route({ auth: 'required', role: 'lister', params: idParam }, async ({ actor, params }) =>
  ok(await submitForReview(actor, params.id)));
