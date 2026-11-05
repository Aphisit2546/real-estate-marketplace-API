import { beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, listingInput, publishedListing, sql, type TestUser } from './helpers';

let owner: TestUser;
let buyer: TestUser;
let stranger: TestUser;
let admin: TestUser;
let listing: string;

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  owner = await createUser(['owner'], 'owner');
  buyer = await createUser([], 'buyer');
  stranger = await createUser([], 'stranger');
  admin = await createUser(['admin'], 'admin');
  listing = await publishedListing(owner, admin);
});

const start = (token: string, listingId = listing, message = 'สนใจห้องนี้ครับ') =>
  api('POST', '/api/v1/conversations', { token, body: { listingId, message } });

describe('messaging', () => {
  it('starts a conversation, notifies the owner and reuses the thread', async () => {
    const first = await start(buyer.token);
    expect(first.status).toBe(201);
    const second = await start(buyer.token, listing, 'ขอถามเพิ่ม');
    expect(second.data.id).toBe(first.data.id);

    const thread = await api('GET', `/api/v1/conversations/${first.data.id}/messages`, { token: owner.token });
    expect(thread.data.messages.map((m: { body: string }) => m.body)).toEqual(['สนใจห้องนี้ครับ', 'ขอถามเพิ่ม']);

    const inbox = await api('GET', '/api/v1/notifications', { token: owner.token });
    expect(inbox.data.some((n: { type: string }) => n.type === 'new_message')).toBe(true);
  });

  it('refuses contacting your own listing', async () => {
    const result = await start(owner.token);
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('SELF_CONVERSATION');
  });

  it('refuses contact about a draft', async () => {
    const draft = await api('POST', '/api/v1/listings', { token: owner.token, body: await listingInput() });
    expect((await start(buyer.token, draft.data.id)).status).toBe(404);
  });

  it('treats a conversation as nonexistent to outsiders', async () => {
    const { data } = await start(buyer.token);
    const read = await api('GET', `/api/v1/conversations/${data.id}/messages`, { token: stranger.token });
    expect(read.status).toBe(404);

    const write = await api('POST', `/api/v1/conversations/${data.id}/messages`, { token: stranger.token, body: { body: 'แอบส่ง' } });
    expect(write.status).toBe(404);

    expect((await api('GET', `/api/v1/conversations/${data.id}/messages`, { token: admin.token })).status).toBe(404);
    expect((await api('POST', `/api/v1/conversations/${data.id}/read`, { token: stranger.token })).status).toBe(404);
  });

  it('shows only your own conversations', async () => {
    const list = await api('GET', '/api/v1/conversations', { token: stranger.token });
    expect(list.data).toEqual([]);
  });

  it('tracks unread counts and read receipts', async () => {
    const user = await createUser();
    const { data } = await start(user.token, listing, 'ข้อความแรก');

    const before = await api('GET', '/api/v1/conversations', { token: owner.token });
    const row = before.data.find((c: { id: string }) => c.id === data.id);
    expect(row.unreadCount).toBe(1);
    expect(row.otherUser.id).toBe(user.id);

    await api('POST', `/api/v1/conversations/${data.id}/read`, { token: owner.token });
    const after = await api('GET', '/api/v1/conversations', { token: owner.token });
    expect(after.data.find((c: { id: string }) => c.id === data.id).unreadCount).toBe(0);

    const thread = await api('GET', `/api/v1/conversations/${data.id}/messages`, { token: user.token });
    expect(thread.data.otherLastReadAt).toBeTruthy();
  });

  it('keeps the conversation readable after the listing is paused', async () => {
    const id = await publishedListing(owner, admin);
    const { data } = await start(buyer.token, id);
    await api('POST', `/api/v1/listings/${id}/pause`, { token: owner.token });
    const thread = await api('GET', `/api/v1/conversations/${data.id}/messages`, { token: buyer.token });
    expect(thread.status).toBe(200);
    expect(thread.data.conversation.listingTitle).toBeTruthy();
  });

  it('stops messages in both directions after a block', async () => {
    const user = await createUser();
    const { data } = await start(user.token);
    expect((await api('POST', '/api/v1/blocks', { token: owner.token, body: { userId: user.id } })).status).toBe(204);

    const send = await api('POST', `/api/v1/conversations/${data.id}/messages`, { token: user.token, body: { body: 'ยังอยู่ไหม' } });
    expect(send.status).toBe(403);
    const reply = await api('POST', `/api/v1/conversations/${data.id}/messages`, { token: owner.token, body: { body: 'ตอบกลับ' } });
    expect(reply.status).toBe(403);
    expect((await start(user.token)).status).toBe(403);

    await api('DELETE', '/api/v1/blocks', { token: owner.token, body: { userId: user.id } });
    const resumed = await api('POST', `/api/v1/conversations/${data.id}/messages`, { token: user.token, body: { body: 'คุยได้แล้ว' } });
    expect(resumed.status).toBe(201);
  });

  it('rate limits messages', async () => {
    const user = await createUser();
    const { data } = await start(user.token);
    // A 60-second window can roll over mid-loop on a slow machine, so this allows for one reset.
    let last = 0;
    for (let i = 0; i < 125 && last !== 429; i += 1) {
      last = (await api('POST', `/api/v1/conversations/${data.id}/messages`, { token: user.token, body: { body: `m${i}` } })).status;
    }
    expect(last).toBe(429);
  }, 120_000);

  it('stores HTML as plain text, leaving escaping to the renderer', async () => {
    const user = await createUser();
    const { data } = await start(user.token, listing, '<img src=x onerror=alert(1)>');
    const thread = await api('GET', `/api/v1/conversations/${data.id}/messages`, { token: user.token });
    expect(thread.data.messages[0].body).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('appointments', () => {
  const book = (token: string, listingId = listing, days = 3) =>
    api('POST', '/api/v1/appointments', { token, body: { listingId, scheduledAt: future(days), note: 'ขอดูช่วงบ่าย' } });
  const act = (token: string, id: string, body: object) => api('PATCH', `/api/v1/appointments/${id}`, { token, body });

  it('runs request, confirm and complete', async () => {
    const user = await createUser();
    const booked = await book(user.token);
    expect(booked.status).toBe(201);
    expect(booked.data).toMatchObject({ status: 'requested', requesterId: user.id, ownerId: owner.id });

    expect((await act(user.token, booked.data.id, { action: 'confirm' })).status).toBe(409);
    expect((await act(owner.token, booked.data.id, { action: 'confirm' })).data.status).toBe('confirmed');
    expect((await act(owner.token, booked.data.id, { action: 'complete' })).data.status).toBe('completed');

    const events = await sql`select status from public.appointment_events where appointment_id = ${booked.data.id} order by id`;
    expect(events.map((event) => event.status)).toEqual(['requested', 'confirmed', 'completed']);
  });

  it('negotiates a new time: only the other party can accept', async () => {
    const user = await createUser();
    const { data } = await book(user.token);
    const newTime = future(5);

    const proposed = await act(owner.token, data.id, { action: 'reschedule', scheduledAt: newTime });
    expect(proposed.data.status).toBe('reschedule_requested');
    expect(proposed.data.proposedAt).toBe(newTime);

    expect((await act(owner.token, data.id, { action: 'accept_reschedule' })).status).toBe(409);
    const accepted = await act(user.token, data.id, { action: 'accept_reschedule' });
    expect(accepted.data).toMatchObject({ status: 'confirmed', scheduledAt: newTime, proposedAt: null });
  });

  it('lets either party cancel but not reopen', async () => {
    const user = await createUser();
    const { data } = await book(user.token);
    expect((await act(user.token, data.id, { action: 'cancel' })).data.status).toBe('cancelled');
    expect((await act(owner.token, data.id, { action: 'confirm' })).status).toBe(409);
  });

  it('allows a fresh booking after the old one is cancelled, but no duplicates while active', async () => {
    const user = await createUser();
    const first = await book(user.token);
    const duplicate = await book(user.token);
    expect(duplicate.status).toBe(409);
    await act(user.token, first.data.id, { action: 'cancel' });
    expect((await book(user.token)).status).toBe(201);
  });

  it('hides appointments from outsiders', async () => {
    const user = await createUser();
    const { data } = await book(user.token);
    expect((await act(stranger.token, data.id, { action: 'cancel' })).status).toBe(404);
    expect((await api('GET', '/api/v1/appointments', { token: stranger.token })).data).toEqual([]);
  });

  it('refuses a past time and self-booking', async () => {
    const past = await api('POST', '/api/v1/appointments', {
      token: buyer.token, body: { listingId: listing, scheduledAt: '2020-01-01T00:00:00Z' },
    });
    expect(past.status).toBe(422);
    const self = await book(owner.token);
    expect(self.status).toBe(422);
    expect(self.error?.code).toBe('SELF_APPOINTMENT');
  });

  it('tells each party about changes', async () => {
    const user = await createUser();
    const { data } = await book(user.token);
    await act(owner.token, data.id, { action: 'confirm' });
    const inbox = await api('GET', '/api/v1/notifications', { token: user.token });
    expect(inbox.meta.unread).toBe(1);
    expect(inbox.data[0].type).toBe('appointment_confirm');

    await api('POST', '/api/v1/notifications/read-all', { token: user.token });
    expect((await api('GET', '/api/v1/notifications', { token: user.token })).meta.unread).toBe(0);
  });
});

describe('notifications', () => {
  it('cannot mark someone else\'s notification as read', async () => {
    const [note] = await sql`select id from public.notifications where user_id = ${owner.id} limit 1`;
    const result = await api('POST', `/api/v1/notifications/${note!.id}/read`, { token: stranger.token });
    expect(result.status).toBe(404);
  });
});

describe('reports', () => {
  it('files one open report per listing per person', async () => {
    const body = { listingId: listing, reason: 'fraud', details: 'ราคาถูกผิดปกติ' };
    const user = await createUser();
    expect((await api('POST', '/api/v1/reports', { token: user.token, body })).status).toBe(201);
    expect((await api('POST', '/api/v1/reports', { token: user.token, body })).status).toBe(409);
  });

  it('requires sign-in and a target', async () => {
    expect((await api('POST', '/api/v1/reports', { body: { listingId: listing, reason: 'fraud' } })).status).toBe(401);
    expect((await api('POST', '/api/v1/reports', { token: buyer.token, body: { reason: 'fraud' } })).status).toBe(422);
  });
});
