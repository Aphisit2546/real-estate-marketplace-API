import { noContent, route } from '@/lib/http';
import { markAllNotificationsRead } from '@/modules/member/member.service';

export const POST = route({ auth: 'required' }, async ({ actor }) => {
  await markAllNotificationsRead(actor);
  return noContent();
});
