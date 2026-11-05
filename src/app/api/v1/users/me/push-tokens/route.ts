import { pushTokenSchema } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { removePushToken, savePushToken } from '@/modules/users/users.service';

export const POST = route({ auth: 'required', body: pushTokenSchema }, async ({ actor, body }) => {
  await savePushToken(actor, body.token, body.platform);
  return noContent();
});
export const DELETE = route({ auth: 'required', body: pushTokenSchema }, async ({ actor, body }) => {
  await removePushToken(actor, body.token);
  return noContent();
});
