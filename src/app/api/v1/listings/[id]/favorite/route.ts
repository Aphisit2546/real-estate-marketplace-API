import { idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { addFavorite, removeFavorite } from '@/modules/member/member.service';

export const POST = route({ auth: 'required', params: idParam }, async ({ actor, params }) => {
  await addFavorite(actor, params.id);
  return noContent();
});
export const DELETE = route({ auth: 'required', params: idParam }, async ({ actor, params }) => {
  await removeFavorite(actor, params.id);
  return noContent();
});
