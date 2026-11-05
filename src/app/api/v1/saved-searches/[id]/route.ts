import { idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { deleteSavedSearch } from '@/modules/member/member.service';

export const DELETE = route({ auth: 'required', params: idParam }, async ({ actor, params }) => {
  await deleteSavedSearch(actor, params.id);
  return noContent();
});
