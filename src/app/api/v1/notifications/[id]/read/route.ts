import { idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { markNotificationRead } from '@/modules/member/member.service';

export const POST = route({ auth: 'required', params: idParam }, async ({ actor, params }) => {
  await markNotificationRead(actor, params.id);
  return noContent();
});
