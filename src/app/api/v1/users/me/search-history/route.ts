import { noContent, ok, route } from '@/lib/http';
import { clearSearchHistory, searchHistory } from '@/modules/member/member.service';

export const GET = route({ auth: 'required' }, async ({ actor }) => ok(await searchHistory(actor)));
export const DELETE = route({ auth: 'required' }, async ({ actor }) => {
  await clearSearchHistory(actor);
  return noContent();
});
