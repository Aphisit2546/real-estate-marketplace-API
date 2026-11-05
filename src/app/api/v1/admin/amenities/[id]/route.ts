import { adminAmenitySchema, numericIdParam } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { saveAmenity } from '@/modules/admin/admin.service';

export const PATCH = route(
  { auth: 'required', role: 'admin', params: numericIdParam, body: adminAmenitySchema },
  async ({ actor, params, body, ip }) => ok(await saveAmenity(actor, params.id, body, ip)),
);
