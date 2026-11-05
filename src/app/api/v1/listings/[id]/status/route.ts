import { idParam, listingStatusActionSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { changeStatus } from '@/modules/listings/listings.service';

export const POST = route(
  { auth: 'required', role: 'lister', params: idParam, body: listingStatusActionSchema },
  async ({ actor, params, body }) => ok(await changeStatus(actor, params.id, body.status)),
);
