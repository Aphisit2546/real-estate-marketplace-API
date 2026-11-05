import { pageQuery } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { notifications } from '@/modules/member/member.service';

export const GET = route({ auth: 'required', query: pageQuery }, async ({ actor, query }) => {
  const { rows, total, unread } = await notifications(actor, query.page, query.limit);
  return ok(rows, {
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), unread },
  });
});
