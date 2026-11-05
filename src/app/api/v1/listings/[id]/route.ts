import { idParam, updateListingSchema } from '@rem/shared';
import { noContent, ok, route } from '@/lib/http';
import { archiveListing, getListing, updateListing } from '@/modules/listings/listings.service';

export const GET = route({ auth: 'optional', params: idParam }, async ({ actor, params }) =>
  ok(await getListing(params.id, actor)));

export const PATCH = route(
  { auth: 'required', role: 'lister', params: idParam, body: updateListingSchema },
  async ({ actor, params, body }) => ok(await updateListing(actor, params.id, body)),
);

export const DELETE = route({ auth: 'required', role: 'lister', params: idParam }, async ({ actor, params }) => {
  await archiveListing(actor, params.id);
  return noContent();
});
