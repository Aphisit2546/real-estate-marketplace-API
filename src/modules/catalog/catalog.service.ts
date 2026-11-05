import type { Amenity, Category, LocationItem, PropertyOption, PublicSettings } from '@rem/shared';
import { withAnon, withService, type Tx } from '@/lib/db';

export const listCategories = () => withAnon(async (tx) => {
  const dailyEnabled = await getSetting(tx, 'daily_rental_enabled', false);
  const rows = await tx<Category[]>`
    select id, slug, name_th, name_en, is_active, sort_order from public.categories
    where is_active and (${dailyEnabled} or slug <> 'daily_room')
    order by sort_order, id`;
  return [...rows];
});

export const listAmenities = () => withAnon(async (tx) => [...await tx<Amenity[]>`
  select id, code, scope, name_th, name_en, is_active, sort_order from public.amenities
  where is_active order by sort_order, id`]);

export const listLocations = (level: string, parentId?: number) => withAnon(async (tx) => {
  const parentFilter = parentId === undefined ? tx`` : tx`and parent_id = ${parentId}`;
  return [...await tx<LocationItem[]>`
    select id, code, level, parent_id, name_th, name_en, postal_code from public.locations
    where level = ${level}::public.location_level ${parentFilter}
    order by name_th`];
});

export async function getSetting<T>(tx: Tx, key: string, fallback: T): Promise<T> {
  const [row] = await tx<{ value: T }[]>`select value from public.application_settings where key = ${key}`;
  return row?.value ?? fallback;
}

export const getPublicSettings = () => withAnon(async (tx): Promise<PublicSettings> => ({
  dailyRentalEnabled: await getSetting(tx, 'daily_rental_enabled', false),
  maxImagesPerListing: await getSetting(tx, 'max_images_per_listing', 20),
  videoEnabled: await getSetting(tx, 'video_enabled', true),
  verificationEnabled: await getSetting(tx, 'verification_enabled', true),
}));

/** Autocomplete over named projects and buildings. Standalone addresses are never exposed. */
export const searchProperties = (q: string) => withService(null, async (tx) => {
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  return [...await tx<PropertyOption[]>`
    select p.id, p.kind, p.name_th, p.name_en, p.address, prov.name_th as province, dist.name_th as district
    from public.properties p
    join public.locations prov on prov.id = p.province_id
    join public.locations dist on dist.id = p.district_id
    where p.kind <> 'standalone' and (p.name_th ilike ${pattern} or p.name_en ilike ${pattern})
    order by p.name_th
    limit 10`];
});
