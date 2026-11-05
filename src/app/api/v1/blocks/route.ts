import { blockUserSchema } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { blockUser, unblockUser } from '@/modules/messaging/messaging.service';

export const POST = route({ auth: 'required', body: blockUserSchema }, async ({ actor, body }) => {
  await blockUser(actor, body.userId);
  return noContent();
});
export const DELETE = route({ auth: 'required', body: blockUserSchema }, async ({ actor, body }) => {
  await unblockUser(actor, body.userId);
  return noContent();
});
