import { adminUserRoleSchema, idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { setUserRole } from '@/modules/admin/admin.service';

export const POST = route(
  { auth: 'required', role: 'admin', params: idParam, body: adminUserRoleSchema },
  async ({ actor, params, body, ip }) => {
    await setUserRole(actor, params.id, body.role, body.action, ip);
    return noContent();
  },
);
