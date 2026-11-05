import { pageQuery } from '@rem/shared';
import { route } from '@/lib/http';
import { paged } from '@/lib/pagination';
import { favorites } from '@/modules/member/member.service';

export const GET = route({ auth: 'required', query: pageQuery }, async ({ actor, query }) => {
  const { rows, total } = await favorites(actor, query.page, query.limit);
  return paged(rows, total, query);
});
