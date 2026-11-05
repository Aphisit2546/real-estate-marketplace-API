import { imageParams } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { setCover } from '@/modules/listings/listings.service';

export const POST = route({ auth: 'required', role: 'lister', params: imageParams }, async ({ actor, params }) => {
  await setCover(actor, params.id, params.imageId);
  return noContent();
});
