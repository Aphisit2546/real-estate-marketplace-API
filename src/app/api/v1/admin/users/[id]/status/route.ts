import { adminUserStatusSchema, idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { setUserStatus } from '@/modules/admin/admin.service';

export const PATCH = route(
  { auth: 'required', role: 'admin', params: idParam, body: adminUserStatusSchema },
  async ({ actor, params, body, ip }) => {
    await setUserStatus(actor, params.id, body.status, body.reason, ip);
    return noContent();
  },
);
