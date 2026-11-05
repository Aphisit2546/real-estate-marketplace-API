import { idParam, messagesQuery, sendMessageSchema } from '@rem/shared';
import { created, ok, route } from '@/lib/http';
import { getThread, sendMessage } from '@/modules/messaging/messaging.service';

export const GET = route({ auth: 'required', params: idParam, query: messagesQuery }, async ({ actor, params, query }) =>
  ok(await getThread(actor, params.id, query)));

export const POST = route(
  { auth: 'required', params: idParam, body: sendMessageSchema, rateLimit: { name: 'message', max: 60, windowSeconds: 60 } },
  async ({ actor, params, body }) => created(await sendMessage(actor, params.id, body.body, body.refListingId)),
);
