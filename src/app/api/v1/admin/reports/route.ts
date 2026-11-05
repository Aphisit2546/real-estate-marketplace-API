import { adminReportsQuery } from '@rem/shared';
import { route } from '@/lib/http';
import { paged } from '@/lib/pagination';
import { listReports } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin', query: adminReportsQuery }, async ({ query }) => {
  const { rows, total } = await listReports(query.status, query.page, query.limit);
  return paged(rows, total, query);
});
