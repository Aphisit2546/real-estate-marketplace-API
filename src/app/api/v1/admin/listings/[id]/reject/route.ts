import { idParam, rejectListingSchema } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { rejectListing } from '@/modules/listings/listings.service';

export const POST = route(
  { auth: 'required', role: 'admin', params: idParam, body: rejectListingSchema },
  async ({ actor, params, body, ip }) => {
    await rejectListing(actor, params.id, body.reason, ip);
    return noContent();
  },
);
