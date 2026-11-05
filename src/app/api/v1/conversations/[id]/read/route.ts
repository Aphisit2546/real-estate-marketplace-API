import { idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { markRead } from '@/modules/messaging/messaging.service';

export const POST = route({ auth: 'required', params: idParam }, async ({ actor, params }) => {
  await markRead(actor, params.id);
  return noContent();
});
