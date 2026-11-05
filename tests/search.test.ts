import { beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, listingInput, publishedListing, reference, sql, type ApiResult, type TestUser } from './helpers';

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let condoSale: string;
let cheapRent: string;
let bigRent: string;
const marker = `มาร์คเกอร์${Date.now()}`;

const search = (query: string, token?: string) => api('GET', `/api/v1/listings?${query}`, { token });
const ids = (result: ApiResult): string[] => result.data.map((row: { id: string }) => row.id);

beforeAll(async () => {
  owner = await createUser(['owner']);
  admin = await createUser(['admin']);
  member = await createUser();
  const { condoId } = await reference();
  const [aircon] = await sql`select id from public.amenities where code = 'air_con'`;

  condoSale = await publishedListing(owner, admin, {
    purpose: 'sale', monthlyRent: undefined, salePrice: 2500000,
    title: `ขายคอนโดหรู อโศก ${marker}`, unit: { areaSqm: 80, bedrooms: 2, bathrooms: 2, furnishing: 'full' },
    categoryId: condoId, amenityIds: [aircon!.id],
  });
  cheapRent = await publishedListing(owner, admin, {
    monthlyRent: 8000, title: `ห้องเช่าราคาถูก ${marker}`, unit: { areaSqm: 25, bedrooms: 1, bathrooms: 1 },
  });
  bigRent = await publishedListing(owner, admin, {
    monthlyRent: 50000, title: `เช่าห้องใหญ่พร้อมอยู่ ${marker}`,
    availableFrom: '2099-01-01', unit: { areaSqm: 120, bedrooms: 3, bathrooms: 2 },
  });
});

const within = (extra: string) => search(`q=${encodeURIComponent(marker)}&${extra}`);

describe('filters', () => {
  it('matches Thai keywords without word boundaries', async () => {
    const result = await search(`q=${encodeURIComponent(`อโศก ${marker}`)}`);
    expect(ids(result)).toEqual([condoSale]);
  });

  it('finds a listing by the location name, not just its title', async () => {
    const result = await search(`q=${encodeURIComponent(`วัฒนา ${marker}`)}`);
    expect(ids(result).sort()).toEqual([condoSale, cheapRent, bigRent].sort());
  });

  it('treats LIKE wildcards in a keyword as plain text', async () => {
    const result = await search(`q=${encodeURIComponent('%')}`);
    expect(result.status).toBe(200);
    expect(ids(result)).not.toContain(cheapRent);
  });

  it('is not injectable', async () => {
    const result = await search(`q=${encodeURIComponent(`' or 1=1; drop table public.listings; --`)}`);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
    const [row] = await sql`select count(*)::int as n from public.listings`;
    expect(row!.n).toBeGreaterThan(0);
  });

  it('filters by purpose', async () => {
    expect(ids(await within('purpose=sale'))).toEqual([condoSale]);
  });

  it('filters by price range', async () => {
    expect(ids(await within('minPrice=10000&maxPrice=60000'))).toEqual([bigRent]);
  });

  it('filters by area', async () => {
    expect(ids(await within('minArea=100'))).toEqual([bigRent]);
  });

  it('filters by bedrooms', async () => {
    expect(ids(await within('bedrooms=2'))).toEqual([condoSale]);
  });

  it('filters by furnishing', async () => {
    expect(ids(await within('furnishing=full'))).toEqual([condoSale]);
  });

  it('filters by amenity', async () => {
    const [aircon] = await sql`select id from public.amenities where code = 'air_con'`;
    expect(ids(await within(`amenities=${aircon!.id}`))).toEqual([condoSale]);
  });

  it('filters listings ready to move into', async () => {
    expect(ids(await within('availableNow=true'))).not.toContain(bigRent);
  });

  it('filters by district and by map bounds', async () => {
    const { districtId } = await reference();
    expect(ids(await within(`districtId=${districtId}`))).toHaveLength(3);
    expect(ids(await within('bbox=13.7,100.5,13.8,100.6'))).toHaveLength(3);
    expect(ids(await within('bbox=18,98,19,99'))).toHaveLength(0);
  });

  it('never returns a draft', async () => {
    const draft = await api('POST', '/api/v1/listings', {
      token: owner.token, body: await listingInput({ title: `ฉบับร่างลับ ${marker}` }),
    });
    expect(ids(await search(`q=${encodeURIComponent(marker)}`))).not.toContain(draft.data.id);
  });

  it('rejects an out-of-range page size', async () => {
    expect((await search('limit=1000')).status).toBe(422);
  });
});

describe('sorting and pagination', () => {
  it('sorts by price in both directions', async () => {
    expect(ids(await within('sort=price_asc'))).toEqual([cheapRent, bigRent, condoSale]);
    expect(ids(await within('sort=price_desc'))).toEqual([condoSale, bigRent, cheapRent]);
  });

  it('sorts by newest', async () => {
    expect(ids(await within('sort=newest'))).toEqual([bigRent, cheapRent, condoSale]);
  });

  it('sorts by relevance', async () => {
    const result = await within('sort=relevance');
    expect(result.status).toBe(200);
    expect(result.data).toHaveLength(3);
  });

  for (const sort of ['newest', 'price_asc', 'price_desc', 'relevance']) {
    it(`walks every row exactly once with a cursor (${sort})`, async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ApiResult = await within(`sort=${sort}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.status).toBe(200);
        seen.push(...ids(page));
        cursor = page.meta.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);
    });
  }

  it('rejects a tampered cursor', async () => {
    const result = await search('cursor=not-a-real-cursor');
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('INVALID_CURSOR');
  });
});

describe('favorites and search memory', () => {
  it('marks favorites in results and lists them', async () => {
    expect((await api('POST', `/api/v1/listings/${cheapRent}/favorite`, { token: member.token })).status).toBe(204);
    expect((await api('POST', `/api/v1/listings/${cheapRent}/favorite`, { token: member.token })).status).toBe(204);

    const result = await search(`q=${encodeURIComponent(marker)}&purpose=rent`, member.token);
    const row = result.data.find((listing: { id: string }) => listing.id === cheapRent);
    expect(row.isFavorite).toBe(true);

    const favorites = await api('GET', '/api/v1/favorites', { token: member.token });
    expect(ids(favorites)).toEqual([cheapRent]);
    expect(favorites.meta.total).toBe(1);

    await api('DELETE', `/api/v1/listings/${cheapRent}/favorite`, { token: member.token });
    expect((await api('GET', '/api/v1/favorites', { token: member.token })).data).toEqual([]);
  });

  it('refuses to favorite a listing that is not public', async () => {
    const draft = await api('POST', '/api/v1/listings', { token: owner.token, body: await listingInput() });
    const result = await api('POST', `/api/v1/listings/${draft.data.id}/favorite`, { token: member.token });
    expect(result.status).toBe(404);
  });

  it('records search history for members', async () => {
    const user = await createUser();
    await search('purpose=sale', user.token);
    const history = await api('GET', '/api/v1/users/me/search-history', { token: user.token });
    expect(history.data).toHaveLength(1);
    expect(history.data[0].criteria.purpose).toBe('sale');

    await api('DELETE', '/api/v1/users/me/search-history', { token: user.token });
    expect((await api('GET', '/api/v1/users/me/search-history', { token: user.token })).data).toEqual([]);
  });

  it('saves searches per user', async () => {
    const saved = await api('POST', '/api/v1/saved-searches', {
      token: member.token, body: { name: 'คอนโดอโศก', criteria: { q: 'อโศก', minPrice: 1000 } },
    });
    expect(saved.status).toBe(201);
    expect(saved.data.criteria).toEqual({ q: 'อโศก', minPrice: 1000 });

    const stranger = await createUser();
    expect((await api('GET', '/api/v1/saved-searches', { token: stranger.token })).data).toEqual([]);
    expect((await api('DELETE', `/api/v1/saved-searches/${saved.data.id}`, { token: stranger.token })).status).toBe(404);
    expect((await api('DELETE', `/api/v1/saved-searches/${saved.data.id}`, { token: member.token })).status).toBe(204);
  });
});

describe('catalog', () => {
  it('serves reference data to guests', async () => {
    const provinces = await api('GET', '/api/v1/locations?level=province');
    expect(provinces.data).toHaveLength(77);

    const { provinceId } = await reference();
    const districts = await api('GET', `/api/v1/locations?level=district&parentId=${provinceId}`);
    expect(districts.data).toHaveLength(50);

    expect((await api('GET', '/api/v1/amenities')).data.length).toBeGreaterThan(10);
    const settings = await api('GET', '/api/v1/settings');
    expect(settings.data).toMatchObject({ dailyRentalEnabled: false, maxImagesPerListing: 20 });
  });

  it('hides the daily room category until it is enabled', async () => {
    const before = await api('GET', '/api/v1/categories');
    expect(before.data.map((row: { slug: string }) => row.slug)).not.toContain('daily_room');

    await api('PATCH', '/api/v1/admin/settings/daily_rental_enabled', { token: admin.token, body: { value: true } });
    const after = await api('GET', '/api/v1/categories');
    expect(after.data.map((row: { slug: string }) => row.slug)).toContain('daily_room');
    await api('PATCH', '/api/v1/admin/settings/daily_rental_enabled', { token: admin.token, body: { value: false } });
  });

  it('never exposes standalone addresses through project autocomplete', async () => {
    const result = await api('GET', `/api/v1/properties?q=${encodeURIComponent('อาคารทดสอบ')}`);
    expect(result.data).toEqual([]);
  });
});
