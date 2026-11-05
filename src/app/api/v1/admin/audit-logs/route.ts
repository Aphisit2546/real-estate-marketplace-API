import { adminAuditQuery } from '@rem/shared';
import { route } from '@/lib/http';
import { paged } from '@/lib/pagination';
import { listAuditLogs } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin', query: adminAuditQuery }, async ({ query }) => {
  const { rows, total } = await listAuditLogs(query, query.page, query.limit);
  return paged(rows, total, query);
});
