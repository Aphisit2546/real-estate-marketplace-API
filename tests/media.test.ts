import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, listingInput, pngFile, publishedListing, sql, uploadImage, type TestUser } from './helpers';

let owner: TestUser;
let other: TestUser;
let admin: TestUser;

const draft = async () =>
  (await api('POST', '/api/v1/listings', { token: owner.token, body: await listingInput() })).data.id as string;

const upload = async (id: string, file: File, token = owner.token) => {
  const form = new FormData();
  form.set('file', file);
  return api('POST', `/api/v1/listings/${id}/images`, { token, form });
};

beforeAll(async () => {
  owner = await createUser(['owner']);
  other = await createUser(['owner']);
  admin = await createUser(['admin']);
});

describe('listing images', () => {
  it('stores a re-encoded WebP and marks the first image as cover', async () => {
    const id = await draft();
    const result = await upload(id, await pngFile());
    expect(result.status).toBe(201);
    expect(result.data.isCover).toBe(true);
    expect(result.data.url).toMatch(/\.webp$/);

    const response = await fetch(result.data.url);
    expect(response.headers.get('content-type')).toBe('image/webp');
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(metadata.format).toBe('webp');
  });

  it('strips EXIF metadata such as GPS location', async () => {
    const id = await draft();
    const withExif = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-location' } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await upload(id, new File([new Uint8Array(withExif)], 'a.jpg', { type: 'image/jpeg' }));
    const stored = Buffer.from(await (await fetch(result.data.url)).arrayBuffer());
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
  });

  it('refuses a script disguised as an image', async () => {
    const id = await draft();
    const fake = new File(['<script>alert(1)</script>'], 'evil.png', { type: 'image/png' });
    const result = await upload(id, fake);
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('INVALID_IMAGE');
  });

  it('refuses an unsupported type', async () => {
    const id = await draft();
    const result = await upload(id, new File(['x'], 'a.svg', { type: 'image/svg+xml' }));
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('refuses an oversized file', async () => {
    const id = await draft();
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    const result = await upload(id, big);
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('FILE_TOO_LARGE');
  });

  it('refuses uploads to a listing owned by someone else', async () => {
    const id = await draft();
    const result = await upload(id, await pngFile(), other.token);
    expect(result.status).toBe(404);
  });

  it('enforces the per-listing image limit', async () => {
    const id = await draft();
    await sql`update public.application_settings set value = '2' where key = 'max_images_per_listing'`;
    try {
      await uploadImage(owner.token, id);
      await uploadImage(owner.token, id);
      const third = await uploadImage(owner.token, id);
      expect(third.status).toBe(422);
      expect(third.error?.code).toBe('TOO_MANY_IMAGES');
    } finally {
      await sql`update public.application_settings set value = '20' where key = 'max_images_per_listing'`;
    }
  });

  it('reorders images and rejects an incomplete list', async () => {
    const id = await draft();
    const first = await uploadImage(owner.token, id);
    const second = await uploadImage(owner.token, id);
    const body = { imageIds: [second.data.id, first.data.id] };
    expect((await api('PATCH', `/api/v1/listings/${id}/images`, { token: owner.token, body })).status).toBe(204);

    const rows = await sql`select id from public.listing_images where listing_id = ${id} order by sort_order`;
    expect(rows.map((row) => row.id)).toEqual(body.imageIds);

    const partial = await api('PATCH', `/api/v1/listings/${id}/images`, {
      token: owner.token, body: { imageIds: [first.data.id] },
    });
    expect(partial.status).toBe(422);
  });

  it('changes the cover', async () => {
    const id = await draft();
    await uploadImage(owner.token, id);
    const second = await uploadImage(owner.token, id);
    const result = await api('POST', `/api/v1/listings/${id}/images/${second.data.id}/cover`, { token: owner.token });
    expect(result.status).toBe(204);
    const covers = await sql`select id from public.listing_images where listing_id = ${id} and is_cover`;
    expect(covers.map((row) => row.id)).toEqual([second.data.id]);
  });

  it('deletes the file too and promotes a new cover', async () => {
    const id = await draft();
    const first = await uploadImage(owner.token, id);
    const second = await uploadImage(owner.token, id);
    const result = await api('DELETE', `/api/v1/listings/${id}/images/${first.data.id}`, { token: owner.token });
    expect(result.status).toBe(204);

    expect((await fetch(first.data.url)).status).toBe(404);
    const [cover] = await sql`select id from public.listing_images where listing_id = ${id} and is_cover`;
    expect(cover?.id).toBe(second.data.id);
  });

  it('sends a live listing back to review when photos are added', async () => {
    const id = await publishedListing(owner, admin);
    await uploadImage(owner.token, id);
    const [row] = await sql`select status from public.listings where id = ${id}`;
    expect(row?.status).toBe('pending_review');
  });
});

describe('avatars', () => {
  it('replaces the avatar and removes the old file', async () => {
    const user = await createUser();
    const form = new FormData();
    form.set('file', await pngFile());
    const first = await api('POST', '/api/v1/users/me/avatar', { token: user.token, form });
    expect(first.status).toBe(200);

    const next = new FormData();
    next.set('file', await pngFile());
    const second = await api('POST', '/api/v1/users/me/avatar', { token: user.token, form: next });
    expect(second.data.avatarUrl).not.toBe(first.data.avatarUrl);
    expect((await fetch(first.data.avatarUrl)).status).toBe(404);
  });
});

describe('verification documents', () => {
  const submit = async (token: string, file: File) => {
    const form = new FormData();
    form.set('type', 'identity');
    form.append('files', file);
    return api('POST', '/api/v1/verification-requests', { token, form });
  };

  it('stores documents under the user\'s own folder', async () => {
    const user = await createUser();
    const result = await submit(user.token, new File(['%PDF-1.7 test'], 'id.pdf', { type: 'application/pdf' }));
    expect(result.status).toBe(201);

    const [row] = await sql`select document_paths from public.verification_requests where id = ${result.data.id}`;
    expect(row?.document_paths[0]).toMatch(new RegExp(`^${user.id}/`));
  });

  it('refuses a fake PDF', async () => {
    const user = await createUser();
    const result = await submit(user.token, new File(['MZ-not-a-pdf'], 'id.pdf', { type: 'application/pdf' }));
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('INVALID_DOCUMENT');
  });

  it('allows one pending request per type', async () => {
    const user = await createUser();
    const file = new File(['%PDF-1.7 test'], 'id.pdf', { type: 'application/pdf' });
    await submit(user.token, file);
    const repeat = await submit(user.token, file);
    expect(repeat.status).toBe(409);
  });
});
