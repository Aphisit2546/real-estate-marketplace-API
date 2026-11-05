import { adminUsersQuery } from '@rem/shared';
import { route } from '@/lib/http';
import { paged } from '@/lib/pagination';
import { listUsers } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin', query: adminUsersQuery }, async ({ query }) => {
  const { rows, total } = await listUsers(query, query.page, query.limit);
  return paged(rows, total, query);
});
