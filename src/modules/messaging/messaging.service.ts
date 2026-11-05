import type { ConversationSummary, ConversationThread, Message } from '@rem/shared';
import { notifyAndPush } from '@/lib/activity';
import { withService, withUser, type Actor, type Tx } from '@/lib/db';
import { forbidden, notFound, unprocessable } from '@/lib/errors';
import { BUCKETS } from '@/lib/media';
import { publicUrl } from '@/lib/supabase';

interface ConversationRow {
  id: string;
  listingId: string;
  listingTitle: string;
  coverPath: string | null;
  otherId: string;
  otherName: string;
  otherAvatarPath: string | null;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
  isBlocked: boolean;
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    listingId: row.listingId,
    listingTitle: row.listingTitle,
    listingCoverUrl: publicUrl(BUCKETS.listings, row.coverPath),
    otherUser: { id: row.otherId, displayName: row.otherName, avatarUrl: publicUrl(BUCKETS.avatars, row.otherAvatarPath) },
    lastMessage: row.lastMessage,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    unreadCount: row.unreadCount,
    isBlocked: row.isBlocked,
  };
}

/**
 * Runs as service_role because a listing can leave public view (sold, paused)
 * while the conversation about it continues. `mine.user_id` is what scopes it to the caller.
 */
function queryConversations(tx: Tx, actor: Actor, conversationId: string | null) {
  const filter = conversationId ? tx`and v.id = ${conversationId}` : tx``;
  return tx<ConversationRow[]>`
    select v.id, v.listing_id, l.title as listing_title,
      (select i.thumb_path from public.listing_images i where i.listing_id = l.id
       order by i.is_cover desc, i.sort_order limit 1) as cover_path,
      other.user_id as other_id, p.display_name as other_name, p.avatar_path as other_avatar_path,
      last.body as last_message, v.last_message_at,
      (select count(*) from public.messages m
       where m.conversation_id = v.id and m.sender_id <> ${actor.id}
         and (mine.last_read_at is null or m.created_at > mine.last_read_at))::int as unread_count,
      public.is_blocked_between(${actor.id}, other.user_id) as is_blocked
    from public.conversation_participants mine
    join public.conversations v on v.id = mine.conversation_id
    join public.listings l on l.id = v.listing_id
    join public.conversation_participants other on other.conversation_id = v.id and other.user_id <> ${actor.id}
    join public.profiles p on p.id = other.user_id
    left join lateral (
      select m.body from public.messages m where m.conversation_id = v.id order by m.created_at desc limit 1
    ) last on true
    where mine.user_id = ${actor.id} ${filter}
    order by v.last_message_at desc nulls last`;
}

export async function listConversations(actor: Actor) {
  const rows = await withService(null, (tx) => queryConversations(tx, actor, null));
  return rows.map(toSummary);
}

export async function startConversation(actor: Actor, listingId: string, message: string) {
  const { conversationId, ownerId } = await withService(actor.id, async (tx) => {
    const [listing] = await tx<{ ownerId: string }[]>`
      select owner_id from public.listings where id = ${listingId} and status = 'published'`;
    if (!listing) throw notFound('ไม่พบประกาศ');
    if (listing.ownerId === actor.id) throw unprocessable('ไม่สามารถส่งข้อความถึงประกาศของตนเองได้', 'SELF_CONVERSATION');

    const [blocked] = await tx<{ blocked: boolean }[]>`
      select public.is_blocked_between(${actor.id}, ${listing.ownerId}) as blocked`;
    if (blocked?.blocked) throw forbidden('ไม่สามารถติดต่อผู้ใช้นี้ได้', 'USER_BLOCKED');

    const [conversation] = await tx<{ id: string }[]>`
      insert into public.conversations (listing_id, initiator_id, owner_id)
      values (${listingId}, ${actor.id}, ${listing.ownerId})
      on conflict (listing_id, initiator_id) do update set listing_id = excluded.listing_id
      returning id`;
    const id = conversation!.id;
    await tx`
      insert into public.conversation_participants (conversation_id, user_id)
      values (${id}, ${actor.id}), (${id}, ${listing.ownerId})
      on conflict do nothing`;
    await tx`insert into public.messages (conversation_id, sender_id, body) values (${id}, ${actor.id}, ${message})`;
    return { conversationId: id, ownerId: listing.ownerId };
  });

  await notifyAndPush({
    userId: ownerId, type: 'new_message', title: 'มีผู้สนใจส่งข้อความถึงคุณ',
    body: message.slice(0, 120), data: { conversationId },
  });
  return { id: conversationId };
}

export async function getThread(
  actor: Actor,
  id: string,
  options: { before?: string; limit: number },
): Promise<ConversationThread> {
  const [conversation] = await withService(null, (tx) => queryConversations(tx, actor, id));
  // 404, not 403: outsiders should not learn that a conversation exists.
  if (!conversation) throw notFound('ไม่พบบทสนทนา');

  return withUser(actor, async (tx) => {
    const before = options.before ? tx`and created_at < ${options.before}::timestamptz` : tx``;
    const messages = await tx<(Omit<Message, 'createdAt'> & { createdAt: Date })[]>`
      select id, conversation_id, sender_id, kind, body, ref_listing_id, created_at
      from public.messages where conversation_id = ${id} ${before}
      order by created_at desc, id desc limit ${options.limit}`;
    const [other] = await tx<{ lastReadAt: Date | null }[]>`
      select last_read_at from public.conversation_participants
      where conversation_id = ${id} and user_id <> ${actor.id}`;
    return {
      conversation: toSummary(conversation),
      messages: messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })).reverse(),
      otherLastReadAt: other?.lastReadAt?.toISOString() ?? null,
    };
  });
}

export async function sendMessage(actor: Actor, id: string, body: string, refListingId?: string) {
  const { message, recipientId } = await withUser(actor, async (tx) => {
    const [other] = await tx<{ userId: string }[]>`
      select user_id from public.conversation_participants
      where conversation_id = ${id} and user_id <> ${actor.id}`;
    if (!other) throw notFound('ไม่พบบทสนทนา');

    const [blocked] = await tx<{ blocked: boolean }[]>`
      select public.is_blocked_between(${actor.id}, ${other.userId}) as blocked`;
    if (blocked?.blocked) throw forbidden('ไม่สามารถส่งข้อความถึงผู้ใช้นี้ได้', 'USER_BLOCKED');

    const [row] = await tx<(Omit<Message, 'createdAt'> & { createdAt: Date })[]>`
      insert into public.messages (conversation_id, sender_id, kind, body, ref_listing_id)
      values (${id}, ${actor.id}, ${refListingId ? 'listing_ref' : 'text'}::public.message_kind, ${body}, ${refListingId ?? null})
      returning id, conversation_id, sender_id, kind, body, ref_listing_id, created_at`;
    await tx`
      update public.conversation_participants set last_read_at = now()
      where conversation_id = ${id} and user_id = ${actor.id}`;
    return { message: row!, recipientId: other.userId };
  });

  await notifyAndPush({
    userId: recipientId, type: 'new_message', title: 'ข้อความใหม่',
    body: body.slice(0, 120), data: { conversationId: id },
  });
  return { ...message, createdAt: message.createdAt.toISOString() };
}

export async function markRead(actor: Actor, id: string) {
  const rows = await withUser(actor, (tx) => tx`
    update public.conversation_participants set last_read_at = now()
    where conversation_id = ${id} and user_id = ${actor.id} returning conversation_id`);
  if (rows.length === 0) throw notFound('ไม่พบบทสนทนา');
}

export async function blockUser(actor: Actor, userId: string) {
  if (userId === actor.id) throw unprocessable('ไม่สามารถบล็อกตนเองได้', 'SELF_BLOCK');
  await withUser(actor, (tx) => tx`
    insert into public.user_blocks (blocker_id, blocked_id) values (${actor.id}, ${userId})
    on conflict do nothing`);
}

export async function unblockUser(actor: Actor, userId: string) {
  await withUser(actor, (tx) =>
    tx`delete from public.user_blocks where blocker_id = ${actor.id} and blocked_id = ${userId}`);
}
