import { ok, route } from '@/lib/http';
import { readUploadedFile } from '@/lib/media';
import { uploadAvatar } from '@/modules/users/users.service';

export const POST = route(
  { auth: 'required', rateLimit: { name: 'avatar', max: 10, windowSeconds: 3600 } },
  async ({ actor, req }) => ok(await uploadAvatar(actor, await readUploadedFile(req))),
);
