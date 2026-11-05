import type {
  AdminDashboard, AdminUser, AppRole, AppSetting, AuditLog, Category, Amenity, ListingStatus, Report, ReportStatus,
  UserStatus, VerificationRequest, VerificationStatus,
} from '@rem/shared';
import { audit, notify } from '@/lib/activity';
import { withService, type Actor, type Tx } from '@/lib/db';
import { conflict, forbidden, notFound } from '@/lib/errors';
import { BUCKETS, signedUrl } from '@/lib/media';
import { adminClient } from '@/lib/supabase';
import { listByOwner } from '@/modules/listings/listings.repository';

const offset = (page: number, limit: number) => (page - 1) * limit;

type ReportRow = Omit<Report, 'createdAt'> & { createdAt: Date };

function reportQuery(tx: Tx, status: ReportStatus | undefined, limit: number, skip: number) {
  const filter = status ? tx`where r.status = ${status}::public.report_status` : tx``;
  return tx<ReportRow[]>`
    select r.id, r.reporter_id, reporter.display_name as reporter_name, r.listing_id, l.title as listing_title,
           r.reported_user_id, reported.display_name as reported_user_name, r.reason, r.details, r.status,
           r.resolution_note, r.created_at
    from public.listing_reports r
    join public.profiles reporter on reporter.id = r.reporter_id
    left join public.listings l on l.id = r.listing_id
    left join public.profiles reported on reported.id = r.reported_user_id
    ${filter}
    order by r.created_at desc
    limit ${limit} offset ${skip}`;
}

const toReport = (row: ReportRow): Report => ({ ...row, createdAt: row.createdAt.toISOString() });

export const dashboard = () => withService(null, async (tx): Promise<AdminDashboard> => {
  const [totals] = await tx<AdminDashboard['totals'][]>`
    select
      (select count(*) from public.profiles)::int as users,
      (select count(*) from public.listings where status <> 'archived')::int as listings,
      (select count(*) from public.listings where status = 'pending_review')::int as pending_listings,
      (select count(*) from public.listings where purpose = 'sale' and status = 'published')::int as sale_listings,
      (select count(*) from public.listings where purpose = 'rent' and status = 'published')::int as rent_listings,
      (select count(*) from public.listings where status = 'rejected')::int as rejected_listings,
      (select count(*) from public.profiles where status = 'suspended')::int as suspended_users,
      (select count(*) from public.listing_reports where status in ('open', 'reviewing'))::int as open_reports`;

  const trends = await tx<AdminDashboard['trends']>`
    select d::date::text as day,
      (select count(*) from public.listings l where l.created_at::date = d::date)::int as listings,
      (select count(*) from public.profiles p where p.created_at::date = d::date)::int as users
    from generate_series(current_date - 29, current_date, interval '1 day') d
    order by d`;

  const recent = await listByOwner(tx, {}, { limit: 5, offset: 0 });
  const reports = await reportQuery(tx, 'open', 5, 0);
  return { totals: totals!, recentListings: recent.rows, pendingReports: reports.map(toReport), trends: [...trends] };
});

export const adminListings = (filter: { status?: ListingStatus; q?: string }, page: number, limit: number) =>
  withService(null, (tx) => listByOwner(
    tx,
    { ...filter, pendingFirst: filter.status === 'pending_review' },
    { limit, offset: offset(page, limit) },
  ));

export const listUsers = (
  filter: { q?: string; status?: UserStatus; role?: AppRole },
  page: number,
  limit: number,
) => withService(null, async (tx) => {
  const conditions = [tx`true`];
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(tx`(p.display_name ilike ${pattern} or p.email ilike ${pattern})`);
  }
  if (filter.status) conditions.push(tx`p.status = ${filter.status}::public.user_status`);
  if (filter.role) {
    conditions.push(tx`exists (select 1 from public.user_roles x where x.user_id = p.id and x.role = ${filter.role}::public.app_role)`);
  }
  const where = conditions.reduce((all, next) => tx`${all} and ${next}`);

  const [count] = await tx<{ total: number }[]>`
    select count(*)::int as total from public.profiles p where ${where}`;
  const rows = await tx<(Omit<AdminUser, 'createdAt'> & { createdAt: Date })[]>`
    select p.id, coalesce(p.email, '') as email, p.display_name, p.phone, p.status, p.verified_at is not null as is_verified, p.created_at,
      coalesce((select array_agg(r.role::text) from public.user_roles r where r.user_id = p.id), '{}') as roles,
      (select count(*) from public.listings l where l.owner_id = p.id)::int as listing_count
    from public.profiles p
    where ${where}
    order by p.created_at desc
    limit ${limit} offset ${offset(page, limit)}`;
  return { rows: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })), total: count?.total ?? 0 };
});

export async function setUserStatus(actor: Actor, id: string, status: 'active' | 'suspended', reason: string | undefined, ip: string) {
  if (id === actor.id) throw forbidden('ไม่สามารถเปลี่ยนสถานะบัญชีของตนเองได้', 'SELF_MODERATION');

  await withService(actor.id, async (tx) => {
    const [user] = await tx<{ status: UserStatus }[]>`select status from public.profiles where id = ${id} for update`;
    if (!user) throw notFound('ไม่พบผู้ใช้');
    if (user.status === 'deactivated') throw conflict('บัญชีนี้ปิดไปแล้ว', 'ACCOUNT_DEACTIVATED');

    await tx`
      update public.profiles set status = ${status}::public.user_status, status_reason = ${reason ?? null}
      where id = ${id}`;
    if (status === 'suspended') {
      await tx`update public.listings set status = 'paused' where owner_id = ${id} and status = 'published'`;
    }
    await audit(tx, {
      actorId: actor.id, action: `user.${status === 'suspended' ? 'suspend' : 'reactivate'}`,
      entityType: 'user', entityId: id, metadata: { reason: reason ?? null }, ip,
    });
  });

  // Also stops new sign-ins. Existing tokens are already refused by the status check in authenticate().
  const { error } = await adminClient().auth.admin.updateUserById(id, {
    ban_duration: status === 'suspended' ? '876000h' : 'none',
  });
  if (error) console.error('Could not update auth ban:', error.message);
}

export async function setUserRole(actor: Actor, id: string, role: AppRole, action: 'grant' | 'revoke', ip: string) {
  if (id === actor.id) throw forbidden('ไม่สามารถเปลี่ยนสิทธิ์ของตนเองได้', 'SELF_MODERATION');
  await withService(actor.id, async (tx) => {
    const [user] = await tx`select id from public.profiles where id = ${id}`;
    if (!user) throw notFound('ไม่พบผู้ใช้');
    if (action === 'grant') {
      await tx`
        insert into public.user_roles (user_id, role, granted_by)
        values (${id}, ${role}::public.app_role, ${actor.id})
        on conflict do nothing`;
    } else {
      await tx`delete from public.user_roles where user_id = ${id} and role = ${role}::public.app_role`;
    }
    await audit(tx, {
      actorId: actor.id, action: `user.role_${action}`, entityType: 'user', entityId: id, metadata: { role }, ip,
    });
  });
}

export const listReports = (status: ReportStatus | undefined, page: number, limit: number) =>
  withService(null, async (tx) => {
    const filter = status ? tx`where status = ${status}::public.report_status` : tx``;
    const [count] = await tx<{ total: number }[]>`select count(*)::int as total from public.listing_reports ${filter}`;
    const rows = await reportQuery(tx, status, limit, offset(page, limit));
    return { rows: rows.map(toReport), total: count?.total ?? 0 };
  });

export async function resolveReport(actor: Actor, id: string, status: ReportStatus, note: string | undefined, ip: string) {
  await withService(actor.id, async (tx) => {
    const rows = await tx`
      update public.listing_reports
      set status = ${status}::public.report_status, resolution_note = ${note ?? null}, resolved_by = ${actor.id}
      where id = ${id} returning id`;
    if (rows.length === 0) throw notFound('ไม่พบรายงาน');
    await audit(tx, { actorId: actor.id, action: 'report.update', entityType: 'report', entityId: id, metadata: { status }, ip });
  });
}

export const listAuditLogs = (filter: { action?: string; actorId?: string }, page: number, limit: number) =>
  withService(null, async (tx) => {
    const conditions = [tx`true`];
    if (filter.action) conditions.push(tx`a.action = ${filter.action}`);
    if (filter.actorId) conditions.push(tx`a.actor_id = ${filter.actorId}`);
    const where = conditions.reduce((all, next) => tx`${all} and ${next}`);
    const [count] = await tx<{ total: number }[]>`select count(*)::int as total from public.audit_logs a where ${where}`;
    const rows = await tx<(Omit<AuditLog, 'createdAt'> & { createdAt: Date })[]>`
      select a.id, a.actor_id, p.display_name as actor_name, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at
      from public.audit_logs a
      left join public.profiles p on p.id = a.actor_id
      where ${where}
      order by a.created_at desc
      limit ${limit} offset ${offset(page, limit)}`;
    return { rows: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })), total: count?.total ?? 0 };
  });

export async function listVerificationRequests(actor: Actor, status: VerificationStatus, ip: string) {
  const rows = await withService(actor.id, async (tx) => {
    const requests = await tx<(VerificationRequest & { documentPaths: string[] })[]>`
      select v.id, v.user_id, p.display_name as user_name, v.type, v.status, v.note, v.review_note, v.document_paths, v.created_at
      from public.verification_requests v
      join public.profiles p on p.id = v.user_id
      where v.status = ${status}::public.verification_status
      order by v.created_at`;
    // Identity documents are sensitive, so viewing them is itself an audited action.
    if (requests.length > 0) {
      await audit(tx, {
        actorId: actor.id, action: 'verification.view_documents', entityType: 'verification',
        metadata: { count: requests.length, status }, ip,
      });
    }
    return requests;
  });

  return Promise.all(rows.map(async ({ documentPaths, ...row }) => ({
    ...row,
    documentUrls: await Promise.all(documentPaths.map((path) => signedUrl(BUCKETS.documents, path))),
  })));
}

export async function reviewVerification(actor: Actor, id: string, status: 'approved' | 'rejected', note: string | undefined, ip: string) {
  await withService(actor.id, async (tx) => {
    const [request] = await tx<{ userId: string; status: VerificationStatus }[]>`
      select user_id, status from public.verification_requests where id = ${id} for update`;
    if (!request) throw notFound('ไม่พบคำขอ');
    if (request.status !== 'pending') throw conflict('คำขอนี้ตรวจสอบไปแล้ว', 'ALREADY_REVIEWED');

    await tx`
      update public.verification_requests
      set status = ${status}::public.verification_status, review_note = ${note ?? null},
          reviewed_by = ${actor.id}, reviewed_at = now()
      where id = ${id}`;
    if (status === 'approved') {
      await tx`update public.profiles set verified_at = now() where id = ${request.userId}`;
    }
    await audit(tx, { actorId: actor.id, action: `verification.${status}`, entityType: 'verification', entityId: id, ip });
    await notify(tx, {
      userId: request.userId, type: 'verification_reviewed',
      title: status === 'approved' ? 'ยืนยันตัวตนสำเร็จ' : 'คำขอยืนยันตัวตนไม่ผ่าน',
      body: note ?? (status === 'approved' ? 'บัญชีของคุณได้รับการยืนยันแล้ว' : 'กรุณาตรวจสอบเอกสารแล้วส่งใหม่'),
    });
  });
}

export const listSettings = () => withService(null, async (tx) => [...await tx<AppSetting[]>`
  select key, value, description, is_public from public.application_settings order by key`]);

export async function updateSetting(actor: Actor, key: string, value: boolean | number | string, ip: string) {
  await withService(actor.id, async (tx) => {
    const rows = await tx`
      update public.application_settings set value = ${tx.json(value)}, updated_by = ${actor.id}
      where key = ${key} returning key`;
    if (rows.length === 0) throw notFound('ไม่พบการตั้งค่า');
    await audit(tx, { actorId: actor.id, action: 'setting.update', entityType: 'setting', entityId: key, metadata: { value }, ip });
  });
}

export const allCategories = () => withService(null, async (tx) => [...await tx<Category[]>`
  select id, slug, name_th, name_en, is_active, sort_order from public.categories order by sort_order, id`]);

export async function saveCategory(
  actor: Actor,
  id: number | null,
  input: { slug: string; nameTh: string; nameEn: string; isActive: boolean; sortOrder: number },
  ip: string,
) {
  return withService(actor.id, async (tx) => {
    const fields = {
      slug: input.slug, name_th: input.nameTh, name_en: input.nameEn, is_active: input.isActive, sort_order: input.sortOrder,
    };
    const rows = id === null
      ? await tx<Category[]>`insert into public.categories ${tx(fields)} returning id, slug, name_th, name_en, is_active, sort_order`
      : await tx<Category[]>`update public.categories set ${tx(fields)} where id = ${id} returning id, slug, name_th, name_en, is_active, sort_order`;
    if (rows.length === 0) throw notFound('ไม่พบหมวดหมู่');
    await audit(tx, { actorId: actor.id, action: 'category.save', entityType: 'category', entityId: String(rows[0]!.id), ip });
    return rows[0]!;
  });
}

export const allAmenities = () => withService(null, async (tx) => [...await tx<Amenity[]>`
  select id, code, scope, name_th, name_en, is_active, sort_order from public.amenities order by sort_order, id`]);

export async function saveAmenity(
  actor: Actor,
  id: number | null,
  input: { code: string; scope: 'building' | 'unit'; nameTh: string; nameEn: string; isActive: boolean; sortOrder: number },
  ip: string,
) {
  return withService(actor.id, async (tx) => {
    const fields = {
      code: input.code, scope: input.scope, name_th: input.nameTh, name_en: input.nameEn,
      is_active: input.isActive, sort_order: input.sortOrder,
    };
    const rows = id === null
      ? await tx<Amenity[]>`insert into public.amenities ${tx(fields)} returning id, code, scope, name_th, name_en, is_active, sort_order`
      : await tx<Amenity[]>`update public.amenities set ${tx(fields)} where id = ${id} returning id, code, scope, name_th, name_en, is_active, sort_order`;
    if (rows.length === 0) throw notFound('ไม่พบสิ่งอำนวยความสะดวก');
    await audit(tx, { actorId: actor.id, action: 'amenity.save', entityType: 'amenity', entityId: String(rows[0]!.id), ip });
    return rows[0]!;
  });
}
