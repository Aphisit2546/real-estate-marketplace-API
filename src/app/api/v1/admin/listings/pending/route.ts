import { pageQuery } from '@rem/shared';
import { route } from '@/lib/http';
import { paged } from '@/lib/pagination';
import { adminListings } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin', query: pageQuery }, async ({ query }) => {
  const { rows, total } = await adminListings({ status: 'pending_review' }, query.page, query.limit);
  return paged(rows, total, query);
});
