import { canTransitionListing, LISTING_TRANSITIONS } from '@rem/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, listingInput, publishedListing, sql, uploadImage, type TestUser } from './helpers';

let owner: TestUser;
let other: TestUser;
let member: TestUser;
let admin: TestUser;

beforeAll(async () => {
  owner = await createUser(['owner'], 'owner');
  other = await createUser(['agent'], 'other');
  member = await createUser([], 'member');
  admin = await createUser(['admin'], 'admin');
});

const create = async (overrides = {}) =>
  api('POST', '/api/v1/listings', { token: owner.token, body: await listingInput(overrides) });

describe('workflow rules', () => {
  it('keeps the shared state machine identical to the database', async () => {
    const rows = await sql`select from_status, to_status, actor from public.listing_transitions`;
    const database = rows.map((row) => `${row.from_status}>${row.to_status}:${row.actor}`).sort();
    const shared = LISTING_TRANSITIONS.map(([from, to, actor]) => `${from}>${to}:${actor}`).sort();
    expect(shared).toEqual(database);
    expect(canTransitionListing('draft', 'pending_review', 'owner')).toBe(true);
  });
});

describe('creating listings', () => {
  it('creates a draft with property and unit', async () => {
    const result = await create();
    expect(result.status).toBe(201);
    expect(result.data).toMatchObject({ status: 'draft', purpose: 'rent', monthlyRent: 15000, areaSqm: 35, isOwner: true });
  });

  it('refuses a member who is not a lister', async () => {
    const result = await api('POST', '/api/v1/listings', { token: member.token, body: await listingInput() });
    expect(result.status).toBe(403);
    expect(result.error?.code).toBe('NOT_A_LISTER');
  });

  it('refuses a guest', async () => {
    expect((await api('POST', '/api/v1/listings', { body: await listingInput() })).status).toBe(401);
  });

  it('ignores owner_id and status sent by the client', async () => {
    const result = await create({ ownerId: other.id, owner_id: other.id, status: 'published' });
    expect(result.status).toBe(201);
    expect(result.data.status).toBe('draft');
    expect(result.data.owner.id).toBe(owner.id);
  });

  it('refuses a district from another province', async () => {
    const base = await listingInput();
    const [chiangMai] = await sql`select id from public.locations where code = '50'`;
    const result = await api('POST', '/api/v1/listings', {
      token: owner.token,
      body: { ...base, property: { ...base.property, provinceId: chiangMai!.id } },
    });
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('INVALID_LOCATION');
  });

  it('refuses daily pricing while the feature is off', async () => {
    const result = await create({ monthlyRent: undefined, dailyRent: 900 });
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('DAILY_RENTAL_DISABLED');
  });

  it('supports several units in one named project', async () => {
    const project = await create({
      property: { ...(await listingInput()).property, kind: 'project', nameTh: 'โครงการร่วมทดสอบ' },
      unit: { areaSqm: 30, unitNumber: 'A-101' },
    });
    const propertyId = project.data.propertyId as string;
    const second = await api('POST', '/api/v1/listings', {
      token: other.token,
      body: await listingInput({ property: undefined, propertyId, unit: { areaSqm: 45, unitNumber: 'A-102' } }),
    });
    expect(second.status).toBe(201);
    expect(second.data.propertyId).toBe(propertyId);
  });
});

describe('ownership', () => {
  it('hides a draft from guests and other users', async () => {
    const { data } = await create();
    expect((await api('GET', `/api/v1/listings/${data.id}`)).status).toBe(404);
    expect((await api('GET', `/api/v1/listings/${data.id}`, { token: other.token })).status).toBe(404);
    expect((await api('GET', `/api/v1/listings/${data.id}`, { token: owner.token })).status).toBe(200);
    expect((await api('GET', `/api/v1/listings/${data.id}`, { token: admin.token })).status).toBe(200);
  });

  it('refuses edits of a listing owned by someone else', async () => {
    const id = await publishedListing(owner, admin);
    const result = await api('PATCH', `/api/v1/listings/${id}`, { token: other.token, body: { title: 'แก้ของคนอื่นไม่ได้' } });
    expect(result.status).toBe(404);
    const [row] = await sql`select title from public.listings where id = ${id}`;
    expect(row?.title).not.toBe('แก้ของคนอื่นไม่ได้');
  });

  it('refuses deleting or pausing a listing owned by someone else', async () => {
    const id = await publishedListing(owner, admin);
    expect((await api('DELETE', `/api/v1/listings/${id}`, { token: other.token })).status).toBe(404);
    expect((await api('POST', `/api/v1/listings/${id}/pause`, { token: other.token })).status).toBe(404);
  });

  it('refuses admin edits through the owner route', async () => {
    const { data } = await create();
    const result = await api('PATCH', `/api/v1/listings/${data.id}`, { token: admin.token, body: { title: 'แก้โดยแอดมินตรง ๆ' } });
    expect(result.status).toBe(404);
  });

  it('refuses stats of a listing owned by someone else', async () => {
    const id = await publishedListing(owner, admin);
    expect((await api('GET', `/api/v1/listings/${id}/stats`, { token: other.token })).status).toBe(404);
  });
});

describe('review workflow', () => {
  it('needs an image before review', async () => {
    const { data } = await create();
    const result = await api('POST', `/api/v1/listings/${data.id}/submit-review`, { token: owner.token });
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('IMAGES_REQUIRED');
  });

  it('publishes only after an admin approves', async () => {
    const { data } = await create();
    await uploadImage(owner.token, data.id);
    const submitted = await api('POST', `/api/v1/listings/${data.id}/submit-review`, { token: owner.token });
    expect(submitted.data.status).toBe('pending_review');
    expect((await api('GET', `/api/v1/listings/${data.id}`)).status).toBe(404);

    expect((await api('POST', `/api/v1/admin/listings/${data.id}/approve`, { token: owner.token })).status).toBe(403);
    expect((await api('POST', `/api/v1/admin/listings/${data.id}/approve`, { token: admin.token })).status).toBe(204);

    const live = await api('GET', `/api/v1/listings/${data.id}`);
    expect(live.status).toBe(200);
    expect(live.data.status).toBe('published');
    expect(live.data.expiresAt).toBeTruthy();

    const [log] = await sql`select actor_id from public.audit_logs where action = 'listing.approve' and entity_id = ${data.id}`;
    expect(log?.actor_id).toBe(admin.id);
    const [note] = await sql`select type from public.notifications where user_id = ${owner.id} and data ->> 'listingId' = ${data.id}`;
    expect(note?.type).toBe('listing_approved');
  });

  it('rejects with a reason that only the owner and admins can read', async () => {
    const { data } = await create();
    await uploadImage(owner.token, data.id);
    await api('POST', `/api/v1/listings/${data.id}/submit-review`, { token: owner.token });
    const rejected = await api('POST', `/api/v1/admin/listings/${data.id}/reject`, {
      token: admin.token, body: { reason: 'รูปภาพไม่ชัดเจน' },
    });
    expect(rejected.status).toBe(204);
    const view = await api('GET', `/api/v1/listings/${data.id}`, { token: owner.token });
    expect(view.data).toMatchObject({ status: 'rejected', rejectedReason: 'รูปภาพไม่ชัดเจน' });
  });

  it('refuses approving a listing that is not pending', async () => {
    const { data } = await create();
    const result = await api('POST', `/api/v1/admin/listings/${data.id}/approve`, { token: admin.token });
    expect(result.status).toBe(409);
  });

  it('returns a live listing to review after a material edit', async () => {
    const id = await publishedListing(owner, admin);
    const result = await api('PATCH', `/api/v1/listings/${id}`, { token: owner.token, body: { monthlyRent: 99000 } });
    expect(result.data.status).toBe('pending_review');
  });

  it('keeps a live listing published after a minor edit', async () => {
    const id = await publishedListing(owner, admin);
    const result = await api('PATCH', `/api/v1/listings/${id}`, { token: owner.token, body: { deposit: 30000 } });
    expect(result.data.status).toBe('published');
    expect(result.data.deposit).toBe(30000);
  });

  it('clears an optional field with null and leaves omitted fields alone', async () => {
    const { data } = await create({ deposit: 5000, contactLine: 'line-id' });
    const result = await api('PATCH', `/api/v1/listings/${data.id}`, { token: owner.token, body: { deposit: null } });
    expect(result.data.deposit).toBeNull();
    expect(result.data.contactLine).toBe('line-id');
  });

  it('pauses, resumes and marks as rented', async () => {
    const id = await publishedListing(owner, admin);
    expect((await api('POST', `/api/v1/listings/${id}/pause`, { token: owner.token })).data.status).toBe('paused');
    expect((await api('GET', `/api/v1/listings/${id}`)).status).toBe(404);
    const resumed = await api('POST', `/api/v1/listings/${id}/status`, { token: owner.token, body: { status: 'published' } });
    expect(resumed.data.status).toBe('published');
    const rented = await api('POST', `/api/v1/listings/${id}/status`, { token: owner.token, body: { status: 'rented' } });
    expect(rented.data.status).toBe('rented');
  });

  it('refuses a jump the state machine does not allow', async () => {
    const { data } = await create();
    const result = await api('POST', `/api/v1/listings/${data.id}/status`, { token: owner.token, body: { status: 'sold' } });
    expect(result.status).toBe(409);
    expect(result.error?.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('archives instead of deleting', async () => {
    const { data } = await create();
    expect((await api('DELETE', `/api/v1/listings/${data.id}`, { token: owner.token })).status).toBe(204);
    const [row] = await sql`select status from public.listings where id = ${data.id}`;
    expect(row?.status).toBe('archived');
  });

  it('blocks a duplicate live listing with the same title', async () => {
    const input = await listingInput();
    const first = await api('POST', '/api/v1/listings', { token: owner.token, body: input });
    await uploadImage(owner.token, first.data.id);
    await api('POST', `/api/v1/listings/${first.data.id}/submit-review`, { token: owner.token });

    const second = await api('POST', '/api/v1/listings', { token: owner.token, body: input });
    await uploadImage(owner.token, second.data.id);
    const result = await api('POST', `/api/v1/listings/${second.data.id}/submit-review`, { token: owner.token });
    expect(result.status).toBe(409);
    expect(result.error?.code).toBe('DUPLICATE');
  });

  it('expires overdue listings through the protected cron route', async () => {
    const id = await publishedListing(owner, admin);
    await sql`update public.listings set expires_at = now() - interval '1 hour' where id = ${id}`;

    const denied = await api('POST', '/api/v1/internal/expire', { headers: { authorization: 'Bearer wrong' } });
    expect(denied.status).toBe(401);

    const result = await api('POST', '/api/v1/internal/expire', { headers: { authorization: 'Bearer test-cron-secret' } });
    expect(result.status).toBe(200);
    expect(result.data.expired).toBeGreaterThanOrEqual(1);
    expect((await api('GET', `/api/v1/listings/${id}`)).status).toBe(404);
  });
});

describe('privacy of a public listing', () => {
  it('hides contact details from guests and the unit number from everyone else', async () => {
    const id = await publishedListing(owner, admin, { unit: { areaSqm: 40, unitNumber: 'B-909' } });
    const guest = await api('GET', `/api/v1/listings/${id}`);
    expect(guest.data).toMatchObject({ contactPhone: null, unitNumber: null, rejectedReason: null });

    const signedIn = await api('GET', `/api/v1/listings/${id}`, { token: member.token });
    expect(signedIn.data.contactPhone).toBe('0812345678');
    expect(signedIn.data.unitNumber).toBeNull();

    const mine = await api('GET', `/api/v1/listings/${id}`, { token: owner.token });
    expect(mine.data.unitNumber).toBe('B-909');
  });
});

describe('statistics', () => {
  it('counts views for live listings only', async () => {
    const id = await publishedListing(owner, admin);
    await api('POST', `/api/v1/listings/${id}/view`);
    await api('POST', `/api/v1/listings/${id}/view`);
    const stats = await api('GET', `/api/v1/listings/${id}/stats`, { token: owner.token });
    expect(stats.data.totalViews).toBe(2);

    const draft = await create();
    await api('POST', `/api/v1/listings/${draft.data.id}/view`);
    const draftStats = await api('GET', `/api/v1/listings/${draft.data.id}/stats`, { token: owner.token });
    expect(draftStats.data.totalViews).toBe(0);
  });

  it('lists only the caller\'s own listings', async () => {
    const mine = await api('GET', '/api/v1/users/me/listings?limit=50', { token: other.token });
    expect(mine.status).toBe(200);
    const ids = new Set(mine.data.map((row: { id: string }) => row.id));
    const [foreign] = await sql`select id from public.listings where owner_id = ${owner.id} limit 1`;
    expect(ids.has(foreign!.id)).toBe(false);
  });
});
