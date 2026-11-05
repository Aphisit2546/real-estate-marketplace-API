import { saveSearchSchema } from '@rem/shared';
import { created, ok, route } from '@/lib/http';
import { savedSearches, saveSearch } from '@/modules/member/member.service';

export const GET = route({ auth: 'required' }, async ({ actor }) => ok(await savedSearches(actor)));
export const POST = route({ auth: 'required', body: saveSearchSchema }, async ({ actor, body }) =>
  created(await saveSearch(actor, body.name, body.criteria)));
