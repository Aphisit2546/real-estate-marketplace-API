import { adminCategorySchema, numericIdParam } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { saveCategory } from '@/modules/admin/admin.service';

export const PATCH = route(
  { auth: 'required', role: 'admin', params: numericIdParam, body: adminCategorySchema },
  async ({ actor, params, body, ip }) => ok(await saveCategory(actor, params.id, body, ip)),
);
