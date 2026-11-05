import {
  canTransitionListing, createListingSchema, EDITABLE_LISTING_STATUSES, hasMaterialChange, isAdmin, LIMITS,
  updateListingSchema, type ListingDetail, type ListingStats, type ListingStatus, type SearchQuery,
} from '@rem/shared';
import type { z } from 'zod';
import { audit, notify, sendPush } from '@/lib/activity';
import { withActor, withService, withUser, type Actor, type Tx } from '@/lib/db';
import { conflict, forbidden, notFound, unprocessable } from '@/lib/errors';
import { BUCKETS, newObjectName, processImage, putObject, removeObjects } from '@/lib/media';
import { publicUrl } from '@/lib/supabase';
import { getSetting } from '@/modules/catalog/catalog.service';
import { findDetail, listByOwner, searchListings } from './listings.repository';

type CreateInput = z.output<typeof createListingSchema>;
type UpdateInput = z.output<typeof updateListingSchema>;

const nullable = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

/** Removes undefined so `tx(object)` only touches the fields that were sent. */
function defined(fields: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as
    Record<string, string | number | boolean | null | string[]>;
}

async function assertCategoryAllowed(tx: Tx, categoryId: number, dailyRent: number | null | undefined) {
  const [category] = await tx<{ slug: string; isActive: boolean }[]>`
    select slug, is_active from public.categories where id = ${categoryId}`;
  if (!category?.isActive) throw unprocessable('ประเภทอสังหาริมทรัพย์ไม่ถูกต้อง', 'INVALID_CATEGORY');
  const dailyEnabled = await getSetting(tx, 'daily_rental_enabled', false);
  if (!dailyEnabled && (category.slug === 'daily_room' || (dailyRent ?? null) !== null)) {
    throw unprocessable('ระบบยังไม่เปิดให้ลงประกาศห้องรายวัน', 'DAILY_RENTAL_DISABLED');
  }
}

async function assertDistrictInProvince(tx: Tx, input: NonNullable<CreateInput['property']>) {
  const [district] = await tx<{ parentId: number | null }[]>`
    select parent_id from public.locations where id = ${input.districtId}`;
  if (district?.parentId !== input.provinceId) {
    throw unprocessable('เขตหรืออำเภอไม่ตรงกับจังหวัดที่เลือก', 'INVALID_LOCATION');
  }
  if (input.subdistrictId !== undefined) {
    const [subdistrict] = await tx<{ parentId: number | null }[]>`
      select parent_id from public.locations where id = ${input.subdistrictId}`;
    if (subdistrict?.parentId !== input.districtId) {
      throw unprocessable('แขวงหรือตำบลไม่ตรงกับเขตที่เลือก', 'INVALID_LOCATION');
    }
  }
}

async function resolveProperty(tx: Tx, actor: Actor, input: CreateInput): Promise<string> {
  if (input.propertyId) {
    const [existing] = await tx<{ id: string }[]>`select id from public.properties where id = ${input.propertyId}`;
    if (!existing) throw unprocessable('ไม่พบโครงการที่เลือก', 'INVALID_PROPERTY');
    return existing.id;
  }
  const property = input.property!;
  await assertDistrictInProvince(tx, property);
  const [row] = await tx<{ id: string }[]>`
    insert into public.properties (
      kind, name_th, name_en, address, province_id, district_id, subdistrict_id, postal_code,
      lat, lng, total_floors, year_built, created_by
    ) values (
      ${property.kind}::public.property_kind, ${property.nameTh}, ${nullable(property.nameEn)}, ${property.address},
      ${property.provinceId}, ${property.districtId}, ${nullable(property.subdistrictId)}, ${nullable(property.postalCode)},
      ${nullable(property.lat)}, ${nullable(property.lng)}, ${nullable(property.totalFloors)},
      ${nullable(property.yearBuilt)}, ${actor.id}
    ) returning id`;
  return row!.id;
}

async function resolveUnit(tx: Tx, actor: Actor, propertyId: string, unit: CreateInput['unit']): Promise<string> {
  if (unit.unitNumber) {
    const [existing] = await tx<{ id: string }[]>`
      select id from public.property_units
      where property_id = ${propertyId} and owner_id = ${actor.id} and unit_number = ${unit.unitNumber}`;
    if (existing) return existing.id;
  }
  const [row] = await tx<{ id: string }[]>`
    insert into public.property_units (
      property_id, owner_id, unit_number, floor, area_sqm, bedrooms, bathrooms, parking_spaces, furnishing, appliances
    ) values (
      ${propertyId}, ${actor.id}, ${nullable(unit.unitNumber)}, ${nullable(unit.floor)}, ${unit.areaSqm},
      ${unit.bedrooms}, ${unit.bathrooms}, ${unit.parkingSpaces}, ${unit.furnishing}::public.furnishing_level,
      ${unit.appliances}
    ) returning id`;
  return row!.id;
}

async function replaceAmenities(tx: Tx, listingId: string, amenityIds: number[]) {
  await tx`delete from public.listing_amenities where listing_id = ${listingId}`;
  const unique = [...new Set(amenityIds)];
  if (unique.length > 0) {
    await tx`
      insert into public.listing_amenities ${tx(unique.map((amenity_id) => ({ listing_id: listingId, amenity_id })))}`;
  }
}

export async function search(query: SearchQuery, actor: Actor | null) {
  // Runs outside RLS for speed: conditions hard-code status = 'published', so per-row
  // policy functions are not needed. A test asserts drafts never appear here.
  const result = await withService(null, async (tx) => {
    const dailyEnabled = await getSetting(tx, 'daily_rental_enabled', false);
    return searchListings(tx, query, actor?.id ?? null, dailyEnabled);
  });

  const { cursor, sort: _sort, limit: _limit, ...criteria } = query;
  const hasCriteria = Object.values(criteria).some((value) => value !== undefined);
  if (actor && !cursor && hasCriteria) {
    await withUser(actor, (tx) => tx`
      insert into public.search_history (user_id, criteria) values (${actor.id}, ${tx.json(criteria as never)})`);
  }
  return result;
}

export async function getListing(id: string, actor: Actor | null): Promise<ListingDetail> {
  const row = await withActor(actor, (tx) => findDetail(tx, id, actor?.id ?? null));
  if (!row) throw notFound('ไม่พบประกาศ');

  const isOwner = actor?.id === row.owner.id;
  const privileged = isOwner || (actor !== null && isAdmin(actor.roles));
  return {
    ...row,
    isOwner,
    // Reachable only by signed-in users, which slows down bulk harvesting of phone numbers.
    contactPhone: actor ? row.contactPhone : null,
    contactLine: actor ? row.contactLine : null,
    unitNumber: privileged ? row.unitNumber : null,
    rejectedReason: privileged ? row.rejectedReason : null,
  };
}

export async function createListing(actor: Actor, input: CreateInput) {
  const id = await withUser(actor, async (tx) => {
    await assertCategoryAllowed(tx, input.categoryId, input.dailyRent);
    const propertyId = await resolveProperty(tx, actor, input);
    const unitId = await resolveUnit(tx, actor, propertyId, input.unit);
    const [row] = await tx<{ id: string }[]>`
      insert into public.listings (
        unit_id, owner_id, category_id, purpose, title, description, sale_price, monthly_rent, daily_rent,
        deposit, booking_fee, additional_terms, rental_terms, min_lease_months, pet_policy, available_from,
        contact_name, contact_phone, contact_line, video_url, virtual_tour_url
      ) values (
        ${unitId}, ${actor.id}, ${input.categoryId}, ${input.purpose}::public.listing_purpose, ${input.title},
        ${input.description}, ${nullable(input.salePrice)}, ${nullable(input.monthlyRent)}, ${nullable(input.dailyRent)},
        ${nullable(input.deposit)}, ${nullable(input.bookingFee)}, ${nullable(input.additionalTerms)},
        ${nullable(input.rentalTerms)}, ${nullable(input.minLeaseMonths)}, ${input.petPolicy}::public.pet_policy,
        ${nullable(input.availableFrom)}::date, ${input.contactName}, ${nullable(input.contactPhone)},
        ${nullable(input.contactLine)}, ${nullable(input.videoUrl)}, ${nullable(input.virtualTourUrl)}
      ) returning id`;
    await replaceAmenities(tx, row!.id, input.amenityIds);
    return row!.id;
  });
  return getListing(id, actor);
}

interface OwnedListing {
  id: string;
  ownerId: string;
  unitId: string;
  status: ListingStatus;
  title: string;
  description: string;
  categoryId: number;
  salePrice: number | null;
  monthlyRent: number | null;
  dailyRent: number | null;
  videoUrl: string | null;
  virtualTourUrl: string | null;
  contactPhone: string | null;
  contactLine: string | null;
}

async function loadOwned(tx: Tx, actor: Actor, id: string): Promise<OwnedListing> {
  const [row] = await tx<OwnedListing[]>`
    select id, owner_id, unit_id, status, title, description, category_id, sale_price, monthly_rent, daily_rent,
           video_url, virtual_tour_url, contact_phone, contact_line
    from public.listings where id = ${id} for update`;
  if (!row) throw notFound('ไม่พบประกาศ');
  // RLS applies the UPDATE policy to FOR UPDATE, so another user's row already came back empty.
  // This check stays so the rule holds even if that policy ever changes.
  if (row.ownerId !== actor.id) throw forbidden('คุณแก้ไขได้เฉพาะประกาศของตนเอง');
  return row;
}

export async function updateListing(actor: Actor, id: string, input: UpdateInput) {
  await withUser(actor, async (tx) => {
    const listing = await loadOwned(tx, actor, id);
    if (!EDITABLE_LISTING_STATUSES.includes(listing.status)) {
      throw conflict('ประกาศสถานะนี้แก้ไขไม่ได้', 'LISTING_NOT_EDITABLE');
    }
    if (input.categoryId !== undefined || input.dailyRent) {
      await assertCategoryAllowed(tx, input.categoryId ?? listing.categoryId, input.dailyRent);
    }

    const { unit, amenityIds, ...content } = input;
    const fields = defined({
      category_id: content.categoryId,
      title: content.title,
      description: content.description,
      sale_price: content.salePrice,
      monthly_rent: content.monthlyRent,
      daily_rent: content.dailyRent,
      deposit: content.deposit,
      booking_fee: content.bookingFee,
      additional_terms: content.additionalTerms,
      rental_terms: content.rentalTerms,
      min_lease_months: content.minLeaseMonths,
      pet_policy: content.petPolicy,
      available_from: content.availableFrom,
      contact_name: content.contactName,
      contact_phone: content.contactPhone,
      contact_line: content.contactLine,
      video_url: content.videoUrl,
      virtual_tour_url: content.virtualTourUrl,
    });

    const unitFields = defined({
      unit_number: unit?.unitNumber,
      floor: unit?.floor,
      area_sqm: unit?.areaSqm,
      bedrooms: unit?.bedrooms,
      bathrooms: unit?.bathrooms,
      parking_spaces: unit?.parkingSpaces,
      furnishing: unit?.furnishing,
      appliances: unit?.appliances,
    });

    const unitChanged = unit?.areaSqm !== undefined || unit?.bedrooms !== undefined || unit?.bathrooms !== undefined;
    const material = hasMaterialChange(listing as unknown as Record<string, unknown>, content) || unitChanged;
    if (material && (listing.status === 'published' || listing.status === 'paused')) {
      fields.status = 'pending_review';
    }

    if (Object.keys(fields).length > 0) {
      await tx`update public.listings set ${tx(fields)} where id = ${id}`;
    }
    if (Object.keys(unitFields).length > 0) {
      await tx`update public.property_units set ${tx(unitFields)} where id = ${listing.unitId}`;
    }
    if (amenityIds) await replaceAmenities(tx, id, amenityIds);
  });
  return getListing(id, actor);
}

async function transition(tx: Tx, actor: Actor, id: string, to: ListingStatus) {
  const listing = await loadOwned(tx, actor, id);
  if (!canTransitionListing(listing.status, to, 'owner')) {
    throw conflict('ไม่สามารถเปลี่ยนสถานะประกาศได้', 'INVALID_STATUS_TRANSITION');
  }
  await tx`update public.listings set status = ${to}::public.listing_status where id = ${id}`;
  return listing;
}

export async function submitForReview(actor: Actor, id: string) {
  await withUser(actor, async (tx) => {
    const [images] = await tx<{ count: number }[]>`
      select count(*)::int as count from public.listing_images where listing_id = ${id}`;
    if (!images?.count) throw unprocessable('กรุณาเพิ่มรูปภาพอย่างน้อย 1 รูปก่อนส่งตรวจสอบ', 'IMAGES_REQUIRED');
    await transition(tx, actor, id, 'pending_review');
  });
  return getListing(id, actor);
}

export async function changeStatus(actor: Actor, id: string, to: ListingStatus) {
  await withUser(actor, async (tx) => {
    await transition(tx, actor, id, to);
  });
  return getListing(id, actor);
}

export async function archiveListing(actor: Actor, id: string) {
  await withUser(actor, async (tx) => {
    await transition(tx, actor, id, 'archived');
  });
}

export async function myListings(actor: Actor, status: ListingStatus | undefined, page: number, limit: number) {
  return withUser(actor, (tx) =>
    listByOwner(tx, { ownerId: actor.id, status }, { limit, offset: (page - 1) * limit }));
}

export async function listingStats(actor: Actor, id: string): Promise<ListingStats> {
  await withUser(actor, (tx) => loadOwned(tx, actor, id));

  // Ownership is proven above. Service role is needed because RLS hides other
  // people's favorites and conversations, and an owner may see the totals only.
  return withService(null, async (tx) => {
    const daily = await tx<ListingStats['daily']>`
      select day::text as day, views from public.listing_daily_stats
      where listing_id = ${id} and day > current_date - 30 order by day`;
    const [counts] = await tx<Omit<ListingStats, 'daily'>[]>`
      select
        coalesce((select sum(views) from public.listing_daily_stats where listing_id = ${id}), 0)::int as total_views,
        (select count(*) from public.favorites where listing_id = ${id})::int as favorite_count,
        (select count(*) from public.conversations where listing_id = ${id})::int as conversation_count,
        (select count(*) from public.appointments where listing_id = ${id})::int as appointment_count`;
    return { ...counts!, daily: [...daily] };
  });
}

export async function recordView(id: string) {
  await withService(null, (tx) => tx`select public.record_listing_view(${id})`);
}

// ---------------------------------------------------------------- images
export async function addImage(actor: Actor, id: string, file: File) {
  const image = await processImage(file, LIMITS.imageMaxBytes);
  const name = newObjectName();
  const storagePath = `listings/${id}/${name}.webp`;
  const thumbPath = `listings/${id}/${name}_thumb.webp`;

  // Checked before any upload, so a rejected request leaves no orphaned files.
  await withUser(actor, async (tx) => {
    await loadOwned(tx, actor, id);
    await assertImageCapacity(tx, id);
  });

  await putObject(BUCKETS.listings, storagePath, image.full, 'image/webp');
  await putObject(BUCKETS.listings, thumbPath, image.thumb, 'image/webp');

  try {
    return await withUser(actor, async (tx) => {
      const listing = await loadOwned(tx, actor, id);
      await assertImageCapacity(tx, id);
      const [position] = await tx<{ next: number; isFirst: boolean }[]>`
        select coalesce(max(sort_order) + 1, 0) as next, count(*) = 0 as is_first
        from public.listing_images where listing_id = ${id}`;
      const [row] = await tx<{ id: string; sortOrder: number; isCover: boolean }[]>`
        insert into public.listing_images (listing_id, storage_path, thumb_path, width, height, byte_size, sort_order, is_cover)
        values (${id}, ${storagePath}, ${thumbPath}, ${image.width}, ${image.height}, ${image.full.length},
                ${position!.next}, ${position!.isFirst})
        returning id, sort_order, is_cover`;
      // New photos on a live listing could change what was approved.
      if (listing.status === 'published' || listing.status === 'paused') {
        await tx`update public.listings set status = 'pending_review' where id = ${id}`;
      }
      return {
        ...row!,
        url: publicUrl(BUCKETS.listings, storagePath),
        thumbUrl: publicUrl(BUCKETS.listings, thumbPath),
        width: image.width,
        height: image.height,
      };
    });
  } catch (error) {
    await removeObjects(BUCKETS.listings, [storagePath, thumbPath]);
    throw error;
  }
}

async function assertImageCapacity(tx: Tx, id: string) {
  const max = await getSetting(tx, 'max_images_per_listing', 20);
  const [row] = await tx<{ count: number }[]>`
    select count(*)::int as count from public.listing_images where listing_id = ${id}`;
  if ((row?.count ?? 0) >= max) throw unprocessable(`เพิ่มรูปได้สูงสุด ${max} รูปต่อประกาศ`, 'TOO_MANY_IMAGES');
}

export async function removeImage(actor: Actor, id: string, imageId: string) {
  const paths = await withUser(actor, async (tx) => {
    await loadOwned(tx, actor, id);
    const [image] = await tx<{ storagePath: string; thumbPath: string; isCover: boolean }[]>`
      delete from public.listing_images where id = ${imageId} and listing_id = ${id}
      returning storage_path, thumb_path, is_cover`;
    if (!image) throw notFound('ไม่พบรูปภาพ');
    if (image.isCover) {
      await tx`
        update public.listing_images set is_cover = true
        where id = (select id from public.listing_images where listing_id = ${id} order by sort_order limit 1)`;
    }
    return [image.storagePath, image.thumbPath];
  });
  await removeObjects(BUCKETS.listings, paths);
}

export async function setCover(actor: Actor, id: string, imageId: string) {
  await withUser(actor, async (tx) => {
    await loadOwned(tx, actor, id);
    const [image] = await tx`select id from public.listing_images where id = ${imageId} and listing_id = ${id}`;
    if (!image) throw notFound('ไม่พบรูปภาพ');
    await tx`update public.listing_images set is_cover = false where listing_id = ${id} and is_cover`;
    await tx`update public.listing_images set is_cover = true where id = ${imageId}`;
  });
}

export async function reorderImages(actor: Actor, id: string, imageIds: string[]) {
  await withUser(actor, async (tx) => {
    await loadOwned(tx, actor, id);
    const existing = await tx<{ id: string }[]>`select id from public.listing_images where listing_id = ${id}`;
    const known = new Set(existing.map((row) => row.id));
    if (imageIds.length !== known.size || !imageIds.every((imageId) => known.has(imageId))) {
      throw unprocessable('รายการรูปภาพไม่ครบหรือไม่ถูกต้อง', 'INVALID_IMAGE_ORDER');
    }
    for (const [index, imageId] of imageIds.entries()) {
      await tx`update public.listing_images set sort_order = ${index} where id = ${imageId}`;
    }
  });
}

// ---------------------------------------------------------------- moderation (admin routes only)
export async function approveListing(actor: Actor, id: string, ip: string) {
  const ownerId = await withService(actor.id, async (tx) => {
    const [listing] = await tx<{ ownerId: string; status: ListingStatus; title: string }[]>`
      select owner_id, status, title from public.listings where id = ${id} for update`;
    if (!listing) throw notFound('ไม่พบประกาศ');
    if (!canTransitionListing(listing.status, 'published', 'system') || listing.status !== 'pending_review') {
      throw conflict('ประกาศนี้ไม่ได้อยู่ในสถานะรอตรวจสอบ', 'INVALID_STATUS_TRANSITION');
    }
    const days = await getSetting(tx, 'listing_expiry_days', 90);
    await tx`
      update public.listings
      set status = 'published', published_at = now(), expires_at = now() + make_interval(days => ${days}),
          reviewed_by = ${actor.id}, reviewed_at = now(), rejected_reason = null
      where id = ${id}`;
    await audit(tx, { actorId: actor.id, action: 'listing.approve', entityType: 'listing', entityId: id, ip });
    await notify(tx, {
      userId: listing.ownerId, type: 'listing_approved', title: 'ประกาศได้รับการอนุมัติ',
      body: `"${listing.title}" เผยแพร่แล้ว`, data: { listingId: id },
    });
    return listing.ownerId;
  });
  await sendPush({ userId: ownerId, type: 'listing_approved', title: 'ประกาศได้รับการอนุมัติ', body: 'ประกาศของคุณเผยแพร่แล้ว', data: { listingId: id } });
}

/** Also takes down a live listing, which is how admins suspend one. */
export async function rejectListing(actor: Actor, id: string, reason: string, ip: string) {
  const ownerId = await withService(actor.id, async (tx) => {
    const [listing] = await tx<{ ownerId: string; status: ListingStatus; title: string }[]>`
      select owner_id, status, title from public.listings where id = ${id} for update`;
    if (!listing) throw notFound('ไม่พบประกาศ');
    if (!canTransitionListing(listing.status, 'rejected', 'system')) {
      throw conflict('ไม่สามารถปฏิเสธประกาศในสถานะนี้ได้', 'INVALID_STATUS_TRANSITION');
    }
    await tx`
      update public.listings
      set status = 'rejected', rejected_reason = ${reason}, reviewed_by = ${actor.id}, reviewed_at = now()
      where id = ${id}`;
    await audit(tx, {
      actorId: actor.id, action: 'listing.reject', entityType: 'listing', entityId: id,
      metadata: { reason, previousStatus: listing.status }, ip,
    });
    await notify(tx, {
      userId: listing.ownerId, type: 'listing_rejected', title: 'ประกาศไม่ผ่านการตรวจสอบ',
      body: `"${listing.title}": ${reason}`, data: { listingId: id },
    });
    return listing.ownerId;
  });
  await sendPush({ userId: ownerId, type: 'listing_rejected', title: 'ประกาศไม่ผ่านการตรวจสอบ', body: reason, data: { listingId: id } });
}

export async function expireListings() {
  return withService(null, async (tx) => {
    const [row] = await tx<{ expired: number }[]>`select public.expire_listings() as expired`;
    return row?.expired ?? 0;
  });
}
