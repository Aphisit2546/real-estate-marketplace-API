import { withService, type Tx } from './db';
import { env } from './env';

/** Written inside the caller's transaction so the action and its audit entry commit together. */
export async function audit(
  tx: Tx,
  entry: {
    actorId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
) {
  const metadata = entry.metadata ?? {};
  await tx`
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata, ip)
    values (${entry.actorId}, ${entry.action}, ${entry.entityType}, ${entry.entityId ?? null},
            ${tx.json(metadata as never)}, ${entry.ip && entry.ip !== '0.0.0.0' ? entry.ip : null})`;
}

export interface NotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** Must run in a service transaction: clients cannot insert notifications. */
export async function notify(tx: Tx, input: NotificationInput) {
  const data = input.data ?? {};
  await tx`
    insert into public.notifications (user_id, type, title, body, data)
    values (${input.userId}, ${input.type}, ${input.title}, ${input.body}, ${tx.json(data)})`;
}

/** Best effort after commit: a push failure must never fail the user's action. */
export async function sendPush(input: NotificationInput) {
  if (env().EXPO_PUSH_ENABLED !== 'true') return;
  try {
    const tokens = await withService(null, (tx) =>
      tx<{ token: string }[]>`select token from public.push_tokens where user_id = ${input.userId}`);
    if (tokens.length === 0) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tokens.map(({ token }) => ({
        to: token, title: input.title, body: input.body, data: input.data ?? {}, sound: 'default',
      }))),
    });
  } catch (error) {
    console.error('Push delivery failed:', error instanceof Error ? error.message : 'unknown');
  }
}

export async function notifyAndPush(input: NotificationInput) {
  await withService(null, (tx) => notify(tx, input));
  await sendPush(input);
}
