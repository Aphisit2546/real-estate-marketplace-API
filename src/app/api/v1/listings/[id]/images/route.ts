import { idParam, reorderImagesSchema } from '@rem/shared';
import { created, noContent, route } from '@/lib/http';
import { readUploadedFile } from '@/lib/media';
import { addImage, reorderImages } from '@/modules/listings/listings.service';

export const POST = route(
  { auth: 'required', role: 'lister', params: idParam, rateLimit: { name: 'upload', max: 60, windowSeconds: 3600 } },
  async ({ actor, params, req }) => created(await addImage(actor, params.id, await readUploadedFile(req))),
);

export const PATCH = route(
  { auth: 'required', role: 'lister', params: idParam, body: reorderImagesSchema },
  async ({ actor, params, body }) => {
    await reorderImages(actor, params.id, body.imageIds);
    return noContent();
  },
);
