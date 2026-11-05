import { ok, route } from '@/lib/http';
import { listSettings } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin' }, async () => ok(await listSettings()));
