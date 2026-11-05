import { adminResolveReportSchema, idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { resolveReport } from '@/modules/admin/admin.service';

export const PATCH = route(
  { auth: 'required', role: 'admin', params: idParam, body: adminResolveReportSchema },
  async ({ actor, params, body, ip }) => {
    await resolveReport(actor, params.id, body.status, body.note, ip);
    return noContent();
  },
);
