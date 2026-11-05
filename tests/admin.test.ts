import { beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, listingInput, publishedListing, sql, uploadImage, type TestUser } from './helpers';

let admin: TestUser;
let owner: TestUser;
let member: TestUser;

beforeAll(async () => {
  admin = await createUser(['admin'], 'admin');
  owner = await createUser(['owner'], 'owner');
  member = await createUser([], 'member');
});

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/api/v1/admin/dashboard'],
  ['GET', '/api/v1/admin/listings'],
  ['GET', '/api/v1/admin/listings/pending'],
  ['GET', '/api/v1/admin/users'],
  ['GET', '/api/v1/admin/reports'],
  ['GET', '/api/v1/admin/audit-logs'],
  ['GET', '/api/v1/admin/verification-requests'],
  ['GET', '/api/v1/admin/settings'],
  ['GET', '/api/v1/admin/categories'],
  ['GET', '/api/v1/admin/amenities'],
];

describe('access control', () => {
  it.each(ADMIN_ROUTES)('%s %s refuses guests, members and owners', async (method, path) => {
    expect((await api(method, path)).status).toBe(401);
    expect((await api(method, path, { token: member.token })).status).toBe(403);
    expect((await api(method, path, { token: owner.token })).status).toBe(403);
    expect((await api(method, path, { token: admin.token })).status).toBe(200);
  });

  it('refuses every mutation from a non-admin', async () => {
    const id = member.id;
    const attempts = [
      api('PATCH', `/api/v1/admin/users/${id}/status`, { token: member.token, body: { status: 'active' } }),
      api('POST', `/api/v1/admin/users/${id}/roles`, { token: member.token, body: { role: 'admin', action: 'grant' } }),
      api('PATCH', '/api/v1/admin/settings/daily_rental_enabled', { token: owner.token, body: { value: true } }),
    ];
    for (const attempt of await Promise.all(attempts)) expect(attempt.status).toBe(403);
    const roles = await sql`select role from public.user_roles where user_id = ${id}`;
    expect(roles.map((row) => row.role)).toEqual(['member']);
  });
});

describe('dashboard', () => {
  it('reports real numbers from the database', async () => {
    const before = await api('GET', '/api/v1/admin/dashboard', { token: admin.token });
    const created = await api('POST', '/api/v1/listings', { token: owner.token, body: await listingInput() });
    await uploadImage(owner.token, created.data.id);
    await api('POST', `/api/v1/listings/${created.data.id}/submit-review`, { token: owner.token });

    const after = await api('GET', '/api/v1/admin/dashboard', { token: admin.token });
    expect(after.data.totals.pendingListings).toBe(before.data.totals.pendingListings + 1);
    expect(after.data.totals.listings).toBe(before.data.totals.listings + 1);
    expect(after.data.trends).toHaveLength(30);
    expect(after.data.recentListings[0].id).toBe(created.data.id);
  });
});

describe('managing users', () => {
  it('finds users by email and role', async () => {
    const result = await api('GET', `/api/v1/admin/users?q=${encodeURIComponent(owner.email)}&role=owner`, { token: admin.token });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: owner.id, email: owner.email });
  });

  it('suspends a user: token dies, listings go down, action is audited', async () => {
    const victim = await createUser(['owner']);
    const listing = await publishedListing(victim, admin);

    const result = await api('PATCH', `/api/v1/admin/users/${victim.id}/status`, {
      token: admin.token, body: { status: 'suspended', reason: 'ละเมิดข้อกำหนด' },
    });
    expect(result.status).toBe(204);

    expect((await api('GET', '/api/v1/auth/me', { token: victim.token })).status).toBe(403);
    expect((await api('GET', `/api/v1/listings/${listing}`)).status).toBe(404);
    const [log] = await sql`select metadata from public.audit_logs where action = 'user.suspend' and entity_id = ${victim.id}`;
    expect(log?.metadata).toMatchObject({ reason: 'ละเมิดข้อกำหนด' });

    await api('PATCH', `/api/v1/admin/users/${victim.id}/status`, { token: admin.token, body: { status: 'active' } });
    expect((await api('GET', '/api/v1/auth/me', { token: victim.token })).status).toBe(200);
  });

  it('applies a role change immediately, without a new token', async () => {
    const user = await createUser();
    await api('POST', `/api/v1/admin/users/${user.id}/roles`, { token: admin.token, body: { role: 'admin', action: 'grant' } });
    expect((await api('GET', '/api/v1/admin/dashboard', { token: user.token })).status).toBe(200);
    await api('POST', `/api/v1/admin/users/${user.id}/roles`, { token: admin.token, body: { role: 'admin', action: 'revoke' } });
    expect((await api('GET', '/api/v1/admin/dashboard', { token: user.token })).status).toBe(403);
  });

  it('stops admins locking themselves out', async () => {
    const status = await api('PATCH', `/api/v1/admin/users/${admin.id}/status`, { token: admin.token, body: { status: 'suspended' } });
    expect(status.status).toBe(403);
    const role = await api('POST', `/api/v1/admin/users/${admin.id}/roles`, { token: admin.token, body: { role: 'admin', action: 'revoke' } });
    expect(role.status).toBe(403);
  });
});

describe('moderation', () => {
  it('takes down a live listing with a reason', async () => {
    const id = await publishedListing(owner, admin);
    const result = await api('POST', `/api/v1/admin/listings/${id}/reject`, { token: admin.token, body: { reason: 'เนื้อหาไม่เหมาะสม' } });
    expect(result.status).toBe(204);
    expect((await api('GET', `/api/v1/listings/${id}`)).status).toBe(404);
  });

  it('requires a reason to reject', async () => {
    const id = await publishedListing(owner, admin);
    const result = await api('POST', `/api/v1/admin/listings/${id}/reject`, { token: admin.token, body: { reason: '' } });
    expect(result.status).toBe(422);
  });

  it('works through reports', async () => {
    const id = await publishedListing(owner, admin);
    const report = await api('POST', '/api/v1/reports', { token: member.token, body: { listingId: id, reason: 'wrong_info' } });
    const open = await api('GET', '/api/v1/admin/reports?status=open', { token: admin.token });
    expect(open.data.some((row: { id: string }) => row.id === report.data.id)).toBe(true);

    const resolved = await api('PATCH', `/api/v1/admin/reports/${report.data.id}`, {
      token: admin.token, body: { status: 'resolved', note: 'แก้ไขแล้ว' },
    });
    expect(resolved.status).toBe(204);
    const [row] = await sql`select status, resolved_by from public.listing_reports where id = ${report.data.id}`;
    expect(row).toMatchObject({ status: 'resolved', resolved_by: admin.id });
  });

  it('reviews a verification request with short-lived document links', async () => {
    const user = await createUser();
    const form = new FormData();
    form.set('type', 'identity');
    form.append('files', new File(['%PDF-1.7 test'], 'id.pdf', { type: 'application/pdf' }));
    const request = await api('POST', '/api/v1/verification-requests', { token: user.token, form });

    const pending = await api('GET', '/api/v1/admin/verification-requests', { token: admin.token });
    const row = pending.data.find((item: { id: string }) => item.id === request.data.id);
    expect(row.documentUrls[0]).toContain('token=');

    const [viewLog] = await sql`select id from public.audit_logs where action = 'verification.view_documents' and actor_id = ${admin.id}`;
    expect(viewLog).toBeTruthy();

    await api('PATCH', `/api/v1/admin/verification-requests/${request.data.id}`, { token: admin.token, body: { status: 'approved' } });
    const me = await api('GET', '/api/v1/users/me', { token: user.token });
    expect(me.data.isVerified).toBe(true);

    const again = await api('PATCH', `/api/v1/admin/verification-requests/${request.data.id}`, { token: admin.token, body: { status: 'rejected' } });
    expect(again.status).toBe(409);
  });
});

describe('catalog management', () => {
  it('adds a new property type that listings can use', async () => {
    const slug = `townhome_${Date.now()}`;
    const created = await api('POST', '/api/v1/admin/categories', {
      token: admin.token, body: { slug, nameTh: 'ทาวน์โฮม', nameEn: 'Townhome', sortOrder: 50 },
    });
    expect(created.status).toBe(201);

    const listing = await api('POST', '/api/v1/listings', {
      token: owner.token, body: await listingInput({ categoryId: created.data.id }),
    });
    expect(listing.status).toBe(201);
    expect(listing.data.categorySlug).toBe(slug);

    await api('PATCH', `/api/v1/admin/categories/${created.data.id}`, {
      token: admin.token, body: { slug, nameTh: 'ทาวน์โฮม', nameEn: 'Townhome', isActive: false },
    });
    const blocked = await api('POST', '/api/v1/listings', {
      token: owner.token, body: await listingInput({ categoryId: created.data.id }),
    });
    expect(blocked.status).toBe(422);
  });

  it('manages amenities and refuses duplicates', async () => {
    const code = `rooftop_${Date.now()}`;
    const body = { code, scope: 'building', nameTh: 'ดาดฟ้า', nameEn: 'Rooftop' };
    expect((await api('POST', '/api/v1/admin/amenities', { token: admin.token, body })).status).toBe(201);
    expect((await api('POST', '/api/v1/admin/amenities', { token: admin.token, body })).status).toBe(409);
  });

  it('logs settings changes', async () => {
    await api('PATCH', '/api/v1/admin/settings/listing_expiry_days', { token: admin.token, body: { value: 60 } });
    const logs = await api('GET', '/api/v1/admin/audit-logs?action=setting.update', { token: admin.token });
    expect(logs.data[0]).toMatchObject({ entityId: 'listing_expiry_days', actorId: admin.id });
    await api('PATCH', '/api/v1/admin/settings/listing_expiry_days', { token: admin.token, body: { value: 90 } });
  });

  it('never exposes private settings publicly', async () => {
    const result = await api('GET', '/api/v1/settings');
    expect(JSON.stringify(result.data)).not.toContain('listing_expiry');
  });
});
