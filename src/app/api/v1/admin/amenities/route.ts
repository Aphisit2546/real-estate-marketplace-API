import { adminAmenitySchema } from '@rem/shared';
import { created, ok, route } from '@/lib/http';
import { allAmenities, saveAmenity } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin' }, async () => ok(await allAmenities()));
export const POST = route({ auth: 'required', role: 'admin', body: adminAmenitySchema }, async ({ actor, body, ip }) =>
  created(await saveAmenity(actor, null, body, ip)));
