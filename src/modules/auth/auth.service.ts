import type { AuthSession, LoginInput, RegisterInput } from '@rem/shared';
import type { Session } from '@supabase/supabase-js';
import { withService, type Actor } from '@/lib/db';
import { env } from '@/lib/env';
import { ApiError, forbidden, unauthorized, unprocessable } from '@/lib/errors';
import { adminClient } from '@/lib/supabase';
import { getCurrentUser } from '@/modules/users/users.service';

function toSession(session: Session): AuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
  };
}

/** Compares whole origins: a prefix check would accept https://site.com.evil.com. */
function isWebOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(env().WEB_URL).origin;
  } catch {
    return false;
  }
}

/** Prevents the email flows being turned into an open redirect. */
function assertSafeRedirect(url: string | undefined) {
  if (!url) return;
  if (url.startsWith('hongmung://') || url.startsWith('exp://')) return;
  if (!isWebOrigin(url)) throw unprocessable('redirectTo ไม่ได้รับอนุญาต', 'INVALID_REDIRECT');
}

export async function register(input: RegisterInput) {
  assertSafeRedirect(input.redirectTo);
  const { data, error } = await adminClient().auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: { display_name: input.displayName },
      emailRedirectTo: input.redirectTo ?? `${env().WEB_URL}/auth/callback`,
    },
  });

  // An existing email gets the same response as a new one, so this endpoint
  // cannot be used to discover who has an account.
  if (error && error.code !== 'user_already_exists') {
    throw new ApiError(400, 'REGISTRATION_FAILED', 'ไม่สามารถสมัครสมาชิกได้ กรุณาลองใหม่');
  }
  return { session: data?.session ? toSession(data.session) : null, needsEmailConfirmation: !data?.session };
}

export async function login(input: LoginInput) {
  const { data, error } = await adminClient().auth.signInWithPassword(input);
  if (error || !data.session) {
    if (error?.code === 'email_not_confirmed') {
      throw forbidden('กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ', 'EMAIL_NOT_CONFIRMED');
    }
    if (error?.code === 'user_banned') throw forbidden('บัญชีนี้ถูกระงับการใช้งาน', 'ACCOUNT_SUSPENDED');
    throw unauthorized('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 'INVALID_CREDENTIALS');
  }

  const userId = data.session.user.id;
  const [profile] = await withService(null, (tx) =>
    tx<{ status: string }[]>`select status from public.profiles where id = ${userId}`);
  if (profile?.status !== 'active') throw forbidden('บัญชีนี้ถูกระงับการใช้งาน', 'ACCOUNT_SUSPENDED');

  return { session: toSession(data.session) };
}

export async function refresh(refreshToken: string): Promise<{ session: AuthSession }> {
  const { data, error } = await adminClient().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) throw unauthorized('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'INVALID_REFRESH_TOKEN');
  return { session: toSession(data.session) };
}

export async function logout(accessToken: string) {
  const { error } = await adminClient().auth.admin.signOut(accessToken, 'local');
  if (error) console.error('Sign-out failed:', error.message);
}

export async function forgotPassword(email: string, redirectTo?: string) {
  assertSafeRedirect(redirectTo);
  const { error } = await adminClient().auth.resetPasswordForEmail(email, {
    redirectTo: redirectTo ?? `${env().WEB_URL}/auth/callback`,
  });
  // Always reported as sent, so this endpoint reveals nothing about which emails exist.
  if (error) console.error('Password recovery failed:', error.message);
}

export async function resendVerification(email: string, redirectTo?: string) {
  assertSafeRedirect(redirectTo);
  const { error } = await adminClient().auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: redirectTo ?? `${env().WEB_URL}/auth/callback` },
  });
  if (error) console.error('Verification resend failed:', error.message);
}

export async function setPassword(userId: string, password: string) {
  const { error } = await adminClient().auth.admin.updateUserById(userId, { password });
  if (error) throw new ApiError(400, 'PASSWORD_UPDATE_FAILED', 'ไม่สามารถเปลี่ยนรหัสผ่านได้');
}

export async function changePassword(actor: Actor, currentPassword: string, newPassword: string) {
  const { error } = await adminClient().auth.signInWithPassword({ email: actor.email, password: currentPassword });
  if (error) throw unauthorized('รหัสผ่านปัจจุบันไม่ถูกต้อง', 'INVALID_CREDENTIALS');
  await setPassword(actor.id, newPassword);
}

export function oauthUrl(provider: 'google', redirectTo: string) {
  assertSafeRedirect(redirectTo);
  const url = new URL(`${env().SUPABASE_URL}/auth/v1/authorize`);
  url.searchParams.set('provider', provider);
  url.searchParams.set('redirect_to', redirectTo);
  return { url: url.toString() };
}

export const currentUser = getCurrentUser;
