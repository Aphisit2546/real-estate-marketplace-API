import { adminListingsQuery } from '@rem/shared';
import { route } from '@/lib/http';
import { paged } from '@/lib/pagination';
import { adminListings } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin', query: adminListingsQuery }, async ({ query }) => {
  const { rows, total } = await adminListings({ status: query.status, q: query.q }, query.page, query.limit);
  return paged(rows, total, query);
});
