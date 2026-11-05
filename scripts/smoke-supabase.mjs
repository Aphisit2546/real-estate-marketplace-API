// End-to-end check of a running API and web app against a real Supabase project.
// Run from apps/api with both apps started. Creates temporary users through the
// Auth admin API, so no email is sent, and removes everything it made afterwards.
// Usage: node scripts/smoke-supabase.mjs
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import sharp from 'sharp';

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n')
  .filter((line) => /^[A-Z_]+=/.test(line))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));

const API = 'http://localhost:4000/api/v1';
const WEB = 'http://localhost:3000';
const SUPABASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const adminHeaders = { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const sql = postgres(env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => undefined });

const stamp = Date.now();
const password = 'Smoke-Test-12345';
const users = [];
const objects = { 'listing-media': [], 'verification-docs': [], avatars: [] };
let failures = 0;

function check(name, passed, detail = '') {
  if (!passed) failures += 1;
  console.info(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function call(method, path, { token, body, form, expect } = {}) {
  const headers = { 'x-forwarded-for': `10.77.${stamp % 250}.${users.length + 1}` };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (expect === undefined && !res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error?.code ?? ''}`);
  return { status: res.status, data: json.data, error: json.error };
}

async function createUser(name) {
  const email = `smoke-${name}-${stamp}@example.com`;
  const res = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: `Smoke ${name}` } }),
  });
  if (!res.ok) throw new Error(`admin create user: ${res.status}`);
  const { id } = await res.json();
  users.push(id);
  const { data } = await call('POST', '/auth/login', { body: { email, password } });
  return { id, email, ...data.session };
}

async function cleanup() {
  const ids = users;
  if (ids.length === 0) return;
  const listings = await sql`select id::text from public.listings where owner_id = any(${ids}::uuid[])`;
  const listingIds = listings.map((row) => row.id);

  await sql.begin(async (tx) => {
    // Audit rows are append-only on purpose, so test rows need the guard lifted for this transaction.
    await tx`alter table public.audit_logs disable trigger audit_logs_append_only`;
    await tx`delete from public.audit_logs where actor_id = any(${ids}::uuid[])
             or entity_id = any(${[...ids, ...listingIds]}::text[])`;
    await tx`alter table public.audit_logs enable trigger audit_logs_append_only`;
    await tx`delete from public.appointments where listing_id = any(${listingIds}::uuid[])`;
    await tx`delete from public.conversations where listing_id = any(${listingIds}::uuid[])`;
    await tx`delete from public.listing_reports where reporter_id = any(${ids}::uuid[])`;
    const units = await tx`select distinct unit_id from public.listings where id = any(${listingIds}::uuid[])`;
    await tx`delete from public.listings where id = any(${listingIds}::uuid[])`;
    const unitIds = units.map((row) => row.unit_id);
    const properties = await tx`select distinct property_id from public.property_units where id = any(${unitIds}::uuid[])`;
    await tx`delete from public.property_units where id = any(${unitIds}::uuid[])`;
    await tx`delete from public.properties where id = any(${properties.map((row) => row.property_id)}::uuid[])`;
  });

  for (const [bucket, prefixes] of Object.entries(objects)) {
    if (prefixes.length === 0) continue;
    await fetch(`${SUPABASE}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: adminHeaders, body: JSON.stringify({ prefixes }) });
  }
  for (const id of ids) {
    const res = await fetch(`${SUPABASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders });
    if (!res.ok) console.error(`could not delete test user ${id}: ${res.status}`);
  }
  const [left] = await sql`select count(*)::int as n from public.profiles where id = any(${ids}::uuid[])`;
  check('cleanup removed all test users', left.n === 0);
}

async function main() {
  const health = await call('GET', '/health');
  check('GET /health', health.status === 200);

  const owner = await createUser('owner');
  const buyer = await createUser('buyer');
  const admin = await createUser('admin');
  check('login with real Supabase Auth, JWKS verification', Boolean(owner.accessToken));
  check('new user gets profile and member role via trigger', (await call('GET', '/auth/me', { token: buyer.accessToken })).data.roles.join() === 'member');

  await sql`insert into public.user_roles (user_id, role) values (${admin.id}, 'admin')`;

  const unconfirmedEmail = `smoke-unconfirmed-${stamp}@example.com`;
  const unconfirmed = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: unconfirmedEmail, password, email_confirm: false }),
  }).then((res) => res.json());
  users.push(unconfirmed.id);
  const blocked = await call('POST', '/auth/login', { body: { email: unconfirmedEmail, password }, expect: 'any' });
  check('unconfirmed email cannot log in', blocked.error?.code === 'EMAIL_NOT_CONFIRMED', blocked.error?.code);

  const wrong = await call('POST', '/auth/login', { body: { email: owner.email, password: 'Wrong-Pass-1' }, expect: 'any' });
  check('wrong password is refused', wrong.status === 401);

  const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken: owner.refreshToken } });
  check('refresh token issues a new session', refreshed.data.session.refreshToken !== owner.refreshToken);
  owner.accessToken = refreshed.data.session.accessToken;
  check('refreshed token works', (await call('GET', '/auth/me', { token: owner.accessToken })).status === 200);

  await call('POST', '/users/me/become-lister', { token: owner.accessToken, body: { role: 'owner' } });
  const [category] = (await call('GET', '/categories')).data;
  const province = (await call('GET', '/locations?level=province')).data.find((row) => row.code === '10');
  const district = (await call('GET', `/locations?level=district&parentId=${province.id}`)).data.find((row) => row.code === '1039');
  const subdistricts = (await call('GET', `/locations?level=subdistrict&parentId=${district.id}`)).data;
  check('full location data is served', subdistricts.length > 0 && Boolean(subdistricts[0].postalCode), `${subdistricts.length} subdistricts`);

  const title = `สโมคเทส ${stamp} คอนโดอโศก`;
  const created = await call('POST', '/listings', {
    token: owner.accessToken,
    body: {
      categoryId: category.id, purpose: 'rent', monthlyRent: 18000, title,
      description: 'ประกาศทดสอบระบบ จะถูกลบอัตโนมัติเมื่อทดสอบเสร็จ', contactName: 'ทดสอบ', contactPhone: '0812345678',
      property: {
        nameTh: `อาคารทดสอบ ${stamp}`, address: '1 ถนนสุขุมวิท', provinceId: province.id, districtId: district.id,
        subdistrictId: subdistricts[0].id, lat: 13.7367, lng: 100.5604,
      },
      unit: { areaSqm: 35, bedrooms: 1, bathrooms: 1, unitNumber: 'S-1' },
    },
  });
  const listingId = created.data.id;
  check('create listing under RLS as authenticated', created.data.status === 'draft');

  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2596BE' } }).png().toBuffer();
  const form = new FormData();
  form.set('file', new File([new Uint8Array(png)], 'room.png', { type: 'image/png' }));
  const image = await call('POST', `/listings/${listingId}/images`, { token: owner.accessToken, form });
  objects['listing-media'].push(`listings/${listingId}/${image.data.url.split('/').pop()}`, `listings/${listingId}/${image.data.thumbUrl.split('/').pop()}`);
  const publicImage = await fetch(image.data.url);
  check('image upload to real Storage, public URL serves WebP', publicImage.ok && publicImage.headers.get('content-type') === 'image/webp');

  const guestDraft = await call('GET', `/listings/${listingId}`, { expect: 'any' });
  check('draft hidden from guests', guestDraft.status === 404);

  await call('POST', `/listings/${listingId}/submit-review`, { token: owner.accessToken });
  const selfApprove = await call('POST', `/admin/listings/${listingId}/approve`, { token: owner.accessToken, expect: 'any' });
  check('owner cannot approve own listing', selfApprove.status === 403);
  await call('POST', `/admin/listings/${listingId}/approve`, { token: admin.accessToken });

  const found = await call('GET', `/listings?q=${encodeURIComponent(String(stamp))}`);
  check('Thai/keyword search finds the published listing', found.data.some((row) => row.id === listingId));

  const page = await fetch(`${WEB}/listings/${listingId}`);
  const html = await page.text();
  check('web renders the listing from the real API', page.ok && html.includes(title));
  check('web sends CSP allowing this project\'s images', (page.headers.get('content-security-policy') ?? '').includes(SUPABASE));

  const guest = await call('GET', `/listings/${listingId}`);
  const member = await call('GET', `/listings/${listingId}`, { token: buyer.accessToken });
  check('phone hidden from guests, shown to members', guest.data.contactPhone === null && member.data.contactPhone === '0812345678');

  await call('POST', `/listings/${listingId}/favorite`, { token: buyer.accessToken });
  const conversation = await call('POST', '/conversations', { token: buyer.accessToken, body: { listingId, message: 'สนใจครับ' } });
  const thread = await call('GET', `/conversations/${conversation.data.id}/messages`, { token: owner.accessToken });
  check('messaging between members', thread.data.messages[0]?.body === 'สนใจครับ');
  const outsider = await call('GET', `/conversations/${conversation.data.id}/messages`, { token: admin.accessToken, expect: 'any' });
  check('outsider cannot read a conversation', outsider.status === 404);

  const appointment = await call('POST', '/appointments', {
    token: buyer.accessToken,
    body: { listingId, scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  });
  const confirmed = await call('PATCH', `/appointments/${appointment.data.id}`, { token: owner.accessToken, body: { action: 'confirm' } });
  check('appointment confirmed', confirmed.data.status === 'confirmed');

  const documents = new FormData();
  documents.set('type', 'identity');
  documents.append('files', new File(['%PDF-1.7 smoke test'], 'id.pdf', { type: 'application/pdf' }));
  const request = await call('POST', '/verification-requests', { token: buyer.accessToken, form: documents });
  const [stored] = await sql`select document_paths from public.verification_requests where id = ${request.data.id}`;
  const documentPath = stored.document_paths[0];
  objects['verification-docs'].push(documentPath);

  const direct = await fetch(`${SUPABASE}/storage/v1/object/public/verification-docs/${documentPath}`);
  check('private document refused at its public URL', !direct.ok, String(direct.status));
  const pending = await call('GET', '/admin/verification-requests', { token: admin.accessToken });
  const signedUrl = pending.data.find((row) => row.id === request.data.id).documentUrls[0];
  check('admin opens private document through signed URL', (await fetch(signedUrl)).ok);

  const dataApi = await fetch(`${SUPABASE}/rest/v1/listings?select=id`, { headers: { apikey: KEY } });
  check('Data API is disabled', !dataApi.ok, String(dataApi.status));

  const suspended = await call('PATCH', `/admin/users/${buyer.id}/status`, { token: admin.accessToken, body: { status: 'suspended', reason: 'smoke test' } });
  check('admin suspends user', suspended.status === 204);
  const live = await call('GET', '/auth/me', { token: buyer.accessToken, expect: 'any' });
  check('suspension blocks a still-valid token at once', live.error?.code === 'ACCOUNT_SUSPENDED');
  const banned = await call('POST', '/auth/login', { body: { email: buyer.email, password }, expect: 'any' });
  check('suspended user cannot log in', banned.status === 403, banned.error?.code);

  const logs = await call('GET', '/admin/audit-logs?action=listing.approve', { token: admin.accessToken });
  check('audit log recorded the approval', logs.data.some((row) => row.entityId === listingId));
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error('ABORTED:', error instanceof Error ? error.message : 'unknown');
} finally {
  try {
    await cleanup();
  } catch (error) {
    failures += 1;
    console.error('CLEANUP FAILED:', error instanceof Error ? error.message : 'unknown', 'users:', users.join(','));
  }
  await sql.end({ timeout: 2 });
}
console.info(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
