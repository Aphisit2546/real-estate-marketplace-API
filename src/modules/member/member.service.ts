import type { NotificationItem, SavedSearch, SearchHistoryItem } from '@rem/shared';
import { withUser, type Actor } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { listFavorites } from '@/modules/listings/listings.repository';

export async function addFavorite(actor: Actor, listingId: string) {
  await withUser(actor, async (tx) => {
    const [listing] = await tx`select id from public.listings where id = ${listingId} and status = 'published'`;
    if (!listing) throw notFound('ไม่พบประกาศ');
    await tx`
      insert into public.favorites (user_id, listing_id) values (${actor.id}, ${listingId})
      on conflict do nothing`;
  });
}

export async function removeFavorite(actor: Actor, listingId: string) {
  await withUser(actor, (tx) =>
    tx`delete from public.favorites where user_id = ${actor.id} and listing_id = ${listingId}`);
}

export const favorites = (actor: Actor, page: number, limit: number) =>
  withUser(actor, (tx) => listFavorites(tx, actor.id, { limit, offset: (page - 1) * limit }));

export const savedSearches = (actor: Actor) => withUser(actor, async (tx) => [...await tx<SavedSearch[]>`
  select id, name, criteria, created_at from public.saved_searches
  where user_id = ${actor.id} order by created_at desc`]);

export async function saveSearch(actor: Actor, name: string, criteria: Record<string, unknown>) {
  const [row] = await withUser(actor, (tx) => tx<SavedSearch[]>`
    insert into public.saved_searches (user_id, name, criteria)
    values (${actor.id}, ${name}, ${tx.json(criteria as never)})
    returning id, name, criteria, created_at`);
  return row!;
}

export async function deleteSavedSearch(actor: Actor, id: string) {
  const rows = await withUser(actor, (tx) =>
    tx`delete from public.saved_searches where id = ${id} and user_id = ${actor.id} returning id`);
  if (rows.length === 0) throw notFound();
}

export const searchHistory = (actor: Actor) => withUser(actor, async (tx) => [...await tx<SearchHistoryItem[]>`
  select id, criteria, created_at from public.search_history
  where user_id = ${actor.id} order by created_at desc limit 20`]);

export async function clearSearchHistory(actor: Actor) {
  await withUser(actor, (tx) => tx`delete from public.search_history where user_id = ${actor.id}`);
}

export const notifications = (actor: Actor, page: number, limit: number) => withUser(actor, async (tx) => {
  const [count] = await tx<{ total: number; unread: number }[]>`
    select count(*)::int as total, count(*) filter (where read_at is null)::int as unread
    from public.notifications where user_id = ${actor.id}`;
  const rows = await tx<NotificationItem[]>`
    select id, type, title, body, data, read_at, created_at from public.notifications
    where user_id = ${actor.id} order by created_at desc
    limit ${limit} offset ${(page - 1) * limit}`;
  return { rows: [...rows], total: count?.total ?? 0, unread: count?.unread ?? 0 };
});

export async function markNotificationRead(actor: Actor, id: string) {
  const rows = await withUser(actor, (tx) =>
    tx`update public.notifications set read_at = now() where id = ${id} and user_id = ${actor.id} returning id`);
  if (rows.length === 0) throw notFound();
}

export async function markAllNotificationsRead(actor: Actor) {
  await withUser(actor, (tx) =>
    tx`update public.notifications set read_at = now() where user_id = ${actor.id} and read_at is null`);
}
