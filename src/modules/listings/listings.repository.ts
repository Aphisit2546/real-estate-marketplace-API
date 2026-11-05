import type {
  Amenity, ListingDetail, ListingImage, ListingStatus, ListingSummary, OwnerListing, SearchQuery,
} from '@rem/shared';
import type { Tx } from '@/lib/db';
import { unprocessable } from '@/lib/errors';
import { BUCKETS } from '@/lib/media';
import { publicUrl } from '@/lib/supabase';

interface SummaryRow extends Omit<ListingSummary, 'coverUrl' | 'publishedAt' | 'createdAt'> {
  coverPath: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}

export const toSummary = <T extends SummaryRow>({ coverPath, ...row }: T) => ({
  ...row,
  coverUrl: publicUrl(BUCKETS.listings, coverPath),
  publishedAt: row.publishedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const summaryColumns = (tx: Tx, viewerId: string | null) => tx`
  l.id, l.title, l.purpose, l.status, c.slug as category_slug, c.name_th as category_name,
  l.sale_price, l.monthly_rent, l.daily_rent, u.area_sqm, u.bedrooms, u.bathrooms, u.floor, u.furnishing,
  coalesce(parent.name_th || ' ', '') || p.name_th as property_name,
  province.name_th as province, district.name_th as district, p.lat, p.lng,
  (select i.thumb_path from public.listing_images i where i.listing_id = l.id
   order by i.is_cover desc, i.sort_order limit 1) as cover_path,
  l.published_at, l.created_at,
  exists (select 1 from public.favorites f where f.listing_id = l.id and f.user_id = ${viewerId}) as is_favorite`;

const summaryJoins = (tx: Tx) => tx`
  from public.listings l
  join public.property_units u on u.id = l.unit_id
  join public.properties p on p.id = u.property_id
  left join public.properties parent on parent.id = p.parent_id
  join public.categories c on c.id = l.category_id
  join public.locations province on province.id = p.province_id
  join public.locations district on district.id = p.district_id`;

// ---------------------------------------------------------------- search
function encodeCursor(sortKey: string | number, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Array.isArray(parsed) && parsed.length === 2 && /^[0-9a-f-]{36}$/.test(String(parsed[1]))) {
      return [String(parsed[0]), String(parsed[1])];
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw unprocessable('cursor ไม่ถูกต้อง', 'INVALID_CURSOR');
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

export function searchConditions(tx: Tx, query: SearchQuery, dailyEnabled: boolean) {
  const conditions = [
    tx`l.status = 'published'`,
    tx`(l.expires_at is null or l.expires_at > now())`,
    tx`c.is_active`,
  ];
  const add = (fragment: (typeof conditions)[number]) => conditions.push(fragment);

  if (!dailyEnabled) add(tx`c.slug <> 'daily_room'`);
  if (query.q) {
    // Every word must match. Trigram matching needs no word segmentation, which Thai requires.
    for (const word of query.q.split(/\s+/).filter(Boolean)) {
      add(tx`l.search_text ilike ${`%${escapeLike(word)}%`}`);
    }
  }
  if (query.purpose) add(tx`l.purpose = ${query.purpose}::public.listing_purpose`);
  if (query.category) add(tx`c.slug = ${query.category}`);
  if (query.provinceId) add(tx`p.province_id = ${query.provinceId}`);
  if (query.districtId) add(tx`p.district_id = ${query.districtId}`);
  if (query.subdistrictId) add(tx`p.subdistrict_id = ${query.subdistrictId}`);
  if (query.propertyId) add(tx`(p.id = ${query.propertyId} or p.parent_id = ${query.propertyId})`);
  if (query.minPrice !== undefined) add(tx`l.price_sort >= ${query.minPrice}`);
  if (query.maxPrice !== undefined) add(tx`l.price_sort <= ${query.maxPrice}`);
  if (query.minArea !== undefined) add(tx`u.area_sqm >= ${query.minArea}`);
  if (query.maxArea !== undefined) add(tx`u.area_sqm <= ${query.maxArea}`);
  if (query.bedrooms !== undefined) add(tx`u.bedrooms = ${query.bedrooms}`);
  if (query.bathrooms !== undefined) add(tx`u.bathrooms >= ${query.bathrooms}`);
  if (query.furnishing) add(tx`u.furnishing = ${query.furnishing}::public.furnishing_level`);
  if (query.availableNow) add(tx`(l.available_from is null or l.available_from <= current_date)`);
  if (query.bbox) {
    const [minLat, minLng, maxLat, maxLng] = query.bbox;
    add(tx`p.lat between ${minLat} and ${maxLat} and p.lng between ${minLng} and ${maxLng}`);
  }
  for (const amenityId of query.amenities ?? []) {
    add(tx`(
      exists (select 1 from public.listing_amenities la where la.listing_id = l.id and la.amenity_id = ${amenityId})
      or exists (select 1 from public.property_amenities pa where pa.property_id = p.id and pa.amenity_id = ${amenityId})
    )`);
  }
  return conditions;
}

function sortPlan(tx: Tx, query: SearchQuery) {
  const sort = query.sort === 'relevance' && !query.q ? 'newest' : query.sort;
  switch (sort) {
    case 'price_asc':
      return { key: tx`l.price_sort`, cast: tx`bigint`, order: tx`l.price_sort asc, l.id asc`, after: tx`>` };
    case 'price_desc':
      return { key: tx`l.price_sort`, cast: tx`bigint`, order: tx`l.price_sort desc, l.id desc`, after: tx`<` };
    case 'relevance': {
      const score = tx`extensions.word_similarity(${query.q ?? ''}, l.search_text)`;
      return { key: score, cast: tx`real`, order: tx`${score} desc, l.id desc`, after: tx`<` };
    }
    default:
      return { key: tx`l.published_at`, cast: tx`timestamptz`, order: tx`l.published_at desc, l.id desc`, after: tx`<` };
  }
}

export async function searchListings(tx: Tx, query: SearchQuery, viewerId: string | null, dailyEnabled: boolean) {
  const conditions = searchConditions(tx, query, dailyEnabled);
  const plan = sortPlan(tx, query);

  if (query.cursor) {
    const [value, id] = decodeCursor(query.cursor);
    conditions.push(tx`(${plan.key}, l.id) ${plan.after} (${value}::${plan.cast}, ${id}::uuid)`);
  }
  const where = conditions.reduce((all, next) => tx`${all} and ${next}`);

  // The sort key is read back as text: a JS Date would truncate microseconds and skip rows.
  const rows = await tx<(SummaryRow & { sortKey: string })[]>`
    select ${summaryColumns(tx, viewerId)}, (${plan.key})::text as sort_key
    ${summaryJoins(tx)}
    where ${where}
    order by ${plan.order}
    limit ${query.limit + 1}`;

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ sortKey: _sortKey, ...row }) => toSummary(row)),
    nextCursor: hasMore && last ? encodeCursor(last.sortKey, last.id) : null,
  };
}

// ---------------------------------------------------------------- detail
type DetailRow = SummaryRow & Omit<ListingDetail,
  keyof ListingSummary | 'images' | 'amenities' | 'owner' | 'isOwner' | 'expiresAt' | 'updatedAt'> & {
    ownerId: string;
    ownerName: string | null;
    ownerAvatarPath: string | null;
    ownerVerified: boolean | null;
    expiresAt: Date | null;
    updatedAt: Date;
  };

export async function findDetail(tx: Tx, id: string, viewerId: string | null) {
  const [row] = await tx<DetailRow[]>`
    select ${summaryColumns(tx, viewerId)},
      l.description, l.deposit, l.booking_fee, l.additional_terms, l.rental_terms, l.min_lease_months,
      l.pet_policy, l.available_from::text as available_from, l.contact_name, l.contact_phone, l.contact_line,
      l.video_url, l.virtual_tour_url, l.category_id, l.rejected_reason, l.expires_at, l.updated_at, l.owner_id,
      p.id as property_id, p.address, p.province_id, p.district_id, p.subdistrict_id, p.postal_code,
      subdistrict.name_th as subdistrict, u.parking_spaces, u.appliances, u.unit_number,
      owner.display_name as owner_name, owner.avatar_path as owner_avatar_path, owner.is_verified as owner_verified
    ${summaryJoins(tx)}
    left join public.locations subdistrict on subdistrict.id = p.subdistrict_id
    left join public.public_profiles owner on owner.id = l.owner_id
    where l.id = ${id}`;
  if (!row) return null;

  const images = await tx<(Omit<ListingImage, 'url' | 'thumbUrl'> & { storagePath: string; thumbPath: string })[]>`
    select id, storage_path, thumb_path, width, height, sort_order, is_cover
    from public.listing_images where listing_id = ${id} order by is_cover desc, sort_order`;

  const amenities = await tx<Amenity[]>`
    select a.id, a.code, a.scope, a.name_th, a.name_en, a.is_active, a.sort_order
    from public.amenities a
    where a.id in (
      select amenity_id from public.listing_amenities where listing_id = ${id}
      union
      select amenity_id from public.property_amenities where property_id = ${row.propertyId}
    )
    order by a.sort_order`;

  const { ownerId, ownerName, ownerAvatarPath, ownerVerified, ...rest } = row;
  return {
    ...toSummary(rest),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    images: images.map(({ storagePath, thumbPath, ...image }) => ({
      ...image,
      url: publicUrl(BUCKETS.listings, storagePath) ?? '',
      thumbUrl: publicUrl(BUCKETS.listings, thumbPath) ?? '',
    })),
    amenities: [...amenities],
    owner: {
      id: ownerId,
      displayName: ownerName ?? 'ผู้ประกาศ',
      avatarUrl: publicUrl(BUCKETS.avatars, ownerAvatarPath),
      isVerified: ownerVerified ?? false,
    },
  };
}

// ---------------------------------------------------------------- owner and admin lists
type OwnerRow = SummaryRow & Omit<OwnerListing, keyof ListingSummary | 'expiresAt'> & { expiresAt: Date | null };

export function toOwnerListing(row: OwnerRow): OwnerListing {
  return { ...toSummary(row), expiresAt: row.expiresAt?.toISOString() ?? null };
}

export async function listByOwner(
  tx: Tx,
  filter: { ownerId?: string; status?: ListingStatus; q?: string; pendingFirst?: boolean },
  page: { limit: number; offset: number },
) {
  const conditions = [tx`true`];
  if (filter.ownerId) conditions.push(tx`l.owner_id = ${filter.ownerId}`);
  if (filter.status) conditions.push(tx`l.status = ${filter.status}::public.listing_status`);
  if (filter.q) conditions.push(tx`l.search_text ilike ${`%${escapeLike(filter.q)}%`}`);
  const where = conditions.reduce((all, next) => tx`${all} and ${next}`);

  const [count] = await tx<{ total: number }[]>`select count(*)::int as total ${summaryJoins(tx)} where ${where}`;
  const rows = await tx<OwnerRow[]>`
    select ${summaryColumns(tx, null)}, l.rejected_reason, l.expires_at,
      coalesce((select sum(s.views) from public.listing_daily_stats s where s.listing_id = l.id), 0)::int as total_views,
      (select count(*) from public.favorites f where f.listing_id = l.id)::int as favorite_count,
      (select count(*) from public.conversations v where v.listing_id = l.id)::int as conversation_count
    ${summaryJoins(tx)}
    where ${where}
    order by ${filter.pendingFirst ? tx`l.created_at asc` : tx`l.created_at desc`}
    limit ${page.limit} offset ${page.offset}`;

  return { rows: rows.map(toOwnerListing), total: count?.total ?? 0 };
}

export async function listFavorites(tx: Tx, userId: string, page: { limit: number; offset: number }) {
  const [count] = await tx<{ total: number }[]>`
    select count(*)::int as total
    from public.favorites f join public.listings l on l.id = f.listing_id
    where f.user_id = ${userId} and l.status = 'published'`;
  const rows = await tx<SummaryRow[]>`
    select ${summaryColumns(tx, userId)}
    ${summaryJoins(tx)}
    join public.favorites mine on mine.listing_id = l.id and mine.user_id = ${userId}
    where l.status = 'published'
    order by mine.created_at desc
    limit ${page.limit} offset ${page.offset}`;
  return { rows: rows.map(toSummary), total: count?.total ?? 0 };
}
