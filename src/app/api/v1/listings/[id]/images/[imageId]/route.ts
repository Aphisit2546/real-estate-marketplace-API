import { imageParams } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { removeImage } from '@/modules/listings/listings.service';

export const DELETE = route({ auth: 'required', role: 'lister', params: imageParams }, async ({ actor, params }) => {
  await removeImage(actor, params.id, params.imageId);
  return noContent();
});
