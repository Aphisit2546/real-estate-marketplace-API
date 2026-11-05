import { idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { approveListing } from '@/modules/listings/listings.service';

export const POST = route({ auth: 'required', role: 'admin', params: idParam }, async ({ actor, params, ip }) => {
  await approveListing(actor, params.id, ip);
  return noContent();
});
