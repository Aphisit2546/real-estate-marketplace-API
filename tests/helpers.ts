import type { AppRole } from '@rem/shared';
import { NextRequest } from 'next/server';
import postgres from 'postgres';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Record<string, Handler | undefined>;

const modules = import.meta.glob<RouteModule>('../src/app/api/v1/**/route.ts');

const routes = Object.keys(modules).map((file) => {
  const pattern = file.replace('../src/app', '').replace('/route.ts', '');
  const names: string[] = [];
  const regex = pattern.replace(/\[(\w+)\]/g, (_match, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { file, names, regex: new RegExp(`^${regex}$`), isStatic: names.length === 0 };
}).sort((a, b) => Number(b.isStatic) - Number(a.isStatic));

export const sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests assert on loosely shaped JSON
  data: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests assert on loosely shaped JSON
  meta: any;
  error?: { code: string; message: string; details?: unknown };
}

let ipCounter = 0;

/** A new IP per call by default, so rate limits only apply in tests that opt in. */
export async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; form?: FormData; ip?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const url = new URL(path, 'http://api.test');
  const found = routes
    .map((route) => ({ route, match: url.pathname.match(route.regex) }))
    .find(({ match }) => match);
  if (!found?.match) throw new Error(`No route for ${path}`);

  const module = await modules[found.route.file]!();
  const handler = module[method];
  if (!handler) throw new Error(`No ${method} handler for ${path}`);

  ipCounter += 1;
  const headers: Record<string, string> = {
    'x-forwarded-for': options.ip ?? `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`,
    ...options.headers,
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const params = Object.fromEntries(found.route.names.map((name, index) => [name, found.match![index + 1]!]));
  const response = await handler(new NextRequest(url, { method, headers, body }), { params: Promise.resolve(params) });

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  return { status: response.status, data: json.data, meta: json.meta, error: json.error };
}

export interface TestUser { id: string; email: string; token: string }

let userCounter = 0;

export async function createUser(roles: AppRole[] = [], name = 'user'): Promise<TestUser> {
  userCounter += 1;
  const email = `${name}${userCounter}-${Date.now()}@example.com`;
  const password = 'Password123';
  const registered = await api('POST', '/api/v1/auth/register', { body: { email, password, displayName: name } });
  if (registered.status !== 201) throw new Error(`register failed: ${JSON.stringify(registered)}`);
  await sql`update auth.users set email_confirmed_at = now() where email = ${email}`;
  const login = await api('POST', '/api/v1/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login)}`);

  const [user] = await sql`select id from auth.users where email = ${email}`;
  const id = user!.id as string;
  for (const role of roles) {
    await sql`insert into public.user_roles (user_id, role) values (${id}, ${role}::public.app_role) on conflict do nothing`;
  }
  return { id, email, token: login.data.session.accessToken };
}

export async function reference() {
  const [province] = await sql`select id from public.locations where code = '10'`;
  const [district] = await sql`select id from public.locations where code = '1039'`;
  const [condo] = await sql`select id from public.categories where slug = 'condo'`;
  return { provinceId: province!.id as number, districtId: district!.id as number, condoId: condo!.id as number };
}

let listingCounter = 0;

export async function listingInput(overrides: Record<string, unknown> = {}) {
  const { provinceId, districtId, condoId } = await reference();
  listingCounter += 1;
  return {
    categoryId: condoId,
    purpose: 'rent',
    monthlyRent: 15000,
    title: `คอนโดให้เช่า ทดสอบ ${listingCounter} ${Date.now()}`,
    description: 'ห้องสวย เฟอร์นิเจอร์ครบ ใกล้รถไฟฟ้า พร้อมเข้าอยู่ทันที',
    contactName: 'ผู้ประกาศทดสอบ',
    contactPhone: '0812345678',
    property: {
      kind: 'standalone',
      nameTh: `อาคารทดสอบ ${listingCounter}`,
      address: '1 ถนนสุขุมวิท',
      provinceId,
      districtId,
      lat: 13.7367,
      lng: 100.5604,
    },
    unit: { areaSqm: 35, bedrooms: 1, bathrooms: 1 },
    ...overrides,
  };
}

/** A valid PNG, generated at test time so no binary fixtures are needed. */
export async function pngFile(name = 'room.png'): Promise<File> {
  const sharp = (await import('sharp')).default;
  const buffer = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2596BE' } }).png().toBuffer();
  return new File([new Uint8Array(buffer)], name, { type: 'image/png' });
}

export async function uploadImage(token: string, listingId: string) {
  const form = new FormData();
  form.set('file', await pngFile());
  return api('POST', `/api/v1/listings/${listingId}/images`, { token, form });
}

/** Runs the full path to a live listing using the real endpoints. */
export async function publishedListing(owner: TestUser, admin: TestUser, overrides: Record<string, unknown> = {}) {
  const created = await api('POST', '/api/v1/listings', { token: owner.token, body: await listingInput(overrides) });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.data.id as string;
  const image = await uploadImage(owner.token, id);
  if (image.status !== 201) throw new Error(`image failed: ${JSON.stringify(image)}`);
  await api('POST', `/api/v1/listings/${id}/submit-review`, { token: owner.token });
  const approved = await api('POST', `/api/v1/admin/listings/${id}/approve`, { token: admin.token });
  if (approved.status !== 204) throw new Error(`approve failed: ${JSON.stringify(approved)}`);
  return id;
}
