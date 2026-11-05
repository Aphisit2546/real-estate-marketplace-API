import { ok, route } from '@/lib/http';
import { dashboard } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin' }, async () => ok(await dashboard()));
