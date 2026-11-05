import { startConversationSchema } from '@rem/shared';
import { created, ok, route } from '@/lib/http';
import { listConversations, startConversation } from '@/modules/messaging/messaging.service';

export const GET = route({ auth: 'required' }, async ({ actor }) => ok(await listConversations(actor)));
export const POST = route(
  { auth: 'required', body: startConversationSchema, rateLimit: { name: 'conversation', max: 20, windowSeconds: 3600 } },
  async ({ actor, body }) => created(await startConversation(actor, body.listingId, body.message)),
);
