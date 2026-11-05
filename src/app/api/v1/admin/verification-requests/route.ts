import { ok, route } from '@/lib/http';
import { listVerificationRequests } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin' }, async ({ actor, ip }) =>
  ok(await listVerificationRequests(actor, 'pending', ip)));
