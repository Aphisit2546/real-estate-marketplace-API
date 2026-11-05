import type { AppRole, CurrentUser, UserStatus } from '@rem/shared';
import { LIMITS } from '@rem/shared';
import { audit } from '@/lib/activity';
import { withService, withUser, type Actor } from '@/lib/db';
import { unauthorized } from '@/lib/errors';
import { BUCKETS, newObjectName, processImage, putObject, removeObjects } from '@/lib/media';
import { adminClient, publicUrl } from '@/lib/supabase';

interface ProfileRow {
  id: string;
  displayName: string;
  phone: string | null;
  lineId: string | null;
  bio: string | null;
  avatarPath: string | null;
  status: UserStatus;
  verifiedAt: Date | null;
  createdAt: Date;
  roles: AppRole[];
}

export async function getCurrentUser(actor: Actor): Promise<CurrentUser> {
  const [row] = await withUser(actor, (tx) => tx<ProfileRow[]>`
    select p.id, p.display_name, p.phone, p.line_id, p.bio, p.avatar_path, p.status, p.verified_at, p.created_at,
           coalesce(array_agg(r.role::text) filter (where r.role is not null), '{}') as roles
    from public.profiles p
    left join public.user_roles r on r.user_id = p.id
    where p.id = ${actor.id}
    group by p.id`);
  if (!row) throw unauthorized();
  return {
    id: row.id,
    email: actor.email,
    displayName: row.displayName,
    phone: row.phone,
    lineId: row.lineId,
    bio: row.bio,
    avatarUrl: publicUrl(BUCKETS.avatars, row.avatarPath),
    status: row.status,
    roles: row.roles,
    isVerified: row.verifiedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function updateProfile(
  actor: Actor,
  input: { displayName?: string; phone?: string | null; lineId?: string | null; bio?: string | null },
) {
  const fields: Record<string, string | null> = {};
  if (input.displayName !== undefined) fields.display_name = input.displayName;
  if (input.phone !== undefined) fields.phone = input.phone === '' ? null : input.phone;
  if (input.lineId !== undefined) fields.line_id = input.lineId || null;
  if (input.bio !== undefined) fields.bio = input.bio || null;

  if (Object.keys(fields).length > 0) {
    await withUser(actor, (tx) => tx`update public.profiles set ${tx(fields)} where id = ${actor.id}`);
  }
  return getCurrentUser(actor);
}

export async function uploadAvatar(actor: Actor, file: File) {
  const image = await processImage(file, LIMITS.avatarMaxBytes, 512);
  const path = `${actor.id}/${newObjectName()}.webp`;
  await putObject(BUCKETS.avatars, path, image.thumb, 'image/webp');

  const previous = await withUser(actor, async (tx) => {
    const [row] = await tx<{ avatarPath: string | null }[]>`select avatar_path from public.profiles where id = ${actor.id}`;
    await tx`update public.profiles set avatar_path = ${path} where id = ${actor.id}`;
    return row?.avatarPath ?? null;
  });
  if (previous) await removeObjects(BUCKETS.avatars, [previous]);
  return getCurrentUser(actor);
}

/** Self-service by design (see A4): publishing still requires admin approval. */
export async function becomeLister(actor: Actor, role: 'owner' | 'agent', ip: string) {
  await withService(actor.id, async (tx) => {
    await tx`
      insert into public.user_roles (user_id, role, granted_by) values (${actor.id}, ${role}, ${actor.id})
      on conflict do nothing`;
    await audit(tx, { actorId: actor.id, action: 'user.become_lister', entityType: 'user', entityId: actor.id, metadata: { role }, ip });
  });
  return getCurrentUser({ ...actor, roles: [...actor.roles, role] });
}

/**
 * Closing an account keeps rows that other people's conversations and history
 * reference, but removes personal data and takes the listings down.
 */
export async function deactivateAccount(actor: Actor, ip: string) {
  await withService(actor.id, async (tx) => {
    await tx`
      update public.listings set status = 'archived'
      where owner_id = ${actor.id}
        and status in ('draft', 'pending_review', 'published', 'paused', 'rejected', 'rented', 'sold', 'expired')`;
    await tx`
      update public.profiles
      set status = 'deactivated', deactivated_at = now(), display_name = 'บัญชีที่ปิดแล้ว',
          email = null, phone = null, line_id = null, bio = null, avatar_path = null
      where id = ${actor.id}`;
    await tx`delete from public.push_tokens where user_id = ${actor.id}`;
    await tx`delete from public.saved_searches where user_id = ${actor.id}`;
    await tx`delete from public.search_history where user_id = ${actor.id}`;
    await audit(tx, { actorId: actor.id, action: 'user.deactivate', entityType: 'user', entityId: actor.id, ip });
  });
  const { error } = await adminClient().auth.admin.updateUserById(actor.id, { ban_duration: '876000h' });
  if (error) console.error('Could not ban deactivated user:', error.message);
}

export async function savePushToken(actor: Actor, token: string, platform: 'ios' | 'android') {
  // A device can change hands, so the token moves to whoever registers it last.
  await withService(actor.id, (tx) => tx`
    insert into public.push_tokens (token, user_id, platform) values (${token}, ${actor.id}, ${platform})
    on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, updated_at = now()`);
}

export async function removePushToken(actor: Actor, token: string) {
  await withUser(actor, (tx) => tx`delete from public.push_tokens where token = ${token}`);
}
