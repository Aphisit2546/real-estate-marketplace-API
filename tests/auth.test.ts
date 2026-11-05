import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { api, createUser, sql } from './helpers';

const password = 'Password123';

describe('registration and login', () => {
  it('requires email confirmation before login', async () => {
    const email = `confirm-${Date.now()}@example.com`;
    const registered = await api('POST', '/api/v1/auth/register', { body: { email, password, displayName: 'สมชาย' } });
    expect(registered.status).toBe(201);
    expect(registered.data.needsEmailConfirmation).toBe(true);

    const blocked = await api('POST', '/api/v1/auth/login', { body: { email, password } });
    expect(blocked.status).toBe(403);
    expect(blocked.error?.code).toBe('EMAIL_NOT_CONFIRMED');

    await sql`update auth.users set email_confirmed_at = now() where email = ${email}`;
    const allowed = await api('POST', '/api/v1/auth/login', { body: { email, password } });
    expect(allowed.status).toBe(200);
    expect(allowed.data.session.accessToken).toBeTruthy();
  });

  it('does not reveal whether an email is already registered', async () => {
    const user = await createUser();
    const repeat = await api('POST', '/api/v1/auth/register', {
      body: { email: user.email, password, displayName: 'ซ้ำ' },
    });
    expect(repeat.status).toBe(201);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const user = await createUser();
    const wrong = await api('POST', '/api/v1/auth/login', { body: { email: user.email, password: 'Wrongpass1' } });
    const unknown = await api('POST', '/api/v1/auth/login', { body: { email: 'nobody@example.com', password } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.error).toEqual(unknown.error);
  });

  it('rejects a weak password', async () => {
    const result = await api('POST', '/api/v1/auth/register', {
      body: { email: 'weak@example.com', password: 'short', displayName: 'x' },
    });
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a redirect to a foreign site', async () => {
    const result = await api('POST', '/api/v1/auth/forgot-password', {
      body: { email: 'a@example.com', redirectTo: 'https://evil.example.com/steal' },
    });
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe('INVALID_REDIRECT');
  });

  it('refuses a lookalike host that starts with the real site', async () => {
    for (const redirectTo of ['http://localhost.evil.com:3000/x', 'http://localhost:30001/x', 'http://localhost:3000@evil.com/x']) {
      const result = await api('POST', '/api/v1/auth/forgot-password', { body: { email: 'a@example.com', redirectTo } });
      expect(result.error?.code, redirectTo).toBe('INVALID_REDIRECT');
    }
  });

  it('accepts the real site and the mobile app scheme', async () => {
    for (const redirectTo of ['http://localhost:3000/auth/callback', 'hongmung://auth/callback']) {
      const result = await api('POST', '/api/v1/auth/forgot-password', { body: { email: 'a@example.com', redirectTo } });
      expect(result.status, redirectTo).toBe(200);
    }
  });

  it('rate limits login attempts per IP', async () => {
    const attempt = () => api('POST', '/api/v1/auth/login', {
      ip: '203.0.113.7', body: { email: 'nobody@example.com', password },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('sessions', () => {
  it('returns the profile for a valid token', async () => {
    const user = await createUser([], 'somchai');
    const me = await api('GET', '/api/v1/auth/me', { token: user.token });
    expect(me.status).toBe(200);
    expect(me.data).toMatchObject({ id: user.id, email: user.email, roles: ['member'], status: 'active' });
  });

  it('rejects a missing token', async () => {
    expect((await api('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a token signed by someone else', async () => {
    const forged = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('00000000-0000-0000-0000-000000000000')
      .setAudience('authenticated')
      .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('attacker-secret'));
    const result = await api('GET', '/api/v1/auth/me', { token: forged });
    expect(result.status).toBe(401);
    expect(result.error?.code).toBe('INVALID_TOKEN');
  });

  it('rotates refresh tokens and refuses reuse', async () => {
    const user = await createUser();
    const login = await api('POST', '/api/v1/auth/login', { body: { email: user.email, password } });
    const { refreshToken } = login.data.session;

    const first = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken } });
    expect(first.status).toBe(200);
    expect(first.data.session.refreshToken).not.toBe(refreshToken);

    const second = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken } });
    expect(second.status).toBe(401);
  });

  it('applies suspension immediately to a token that is still valid', async () => {
    const user = await createUser();
    await sql`update public.profiles set status = 'suspended' where id = ${user.id}`;
    const result = await api('GET', '/api/v1/auth/me', { token: user.token });
    expect(result.status).toBe(403);
    expect(result.error?.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('profile', () => {
  it('updates allowed fields', async () => {
    const user = await createUser();
    const result = await api('PATCH', '/api/v1/users/me', {
      token: user.token, body: { displayName: 'ชื่อใหม่', phone: '0899999999', bio: 'สวัสดี' },
    });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ displayName: 'ชื่อใหม่', phone: '0899999999', bio: 'สวัสดี' });
  });

  it('ignores an attempt to set a role through the profile', async () => {
    const user = await createUser();
    await api('PATCH', '/api/v1/users/me', { token: user.token, body: { displayName: 'x', roles: ['admin'], status: 'active' } });
    const me = await api('GET', '/api/v1/users/me', { token: user.token });
    expect(me.data.roles).toEqual(['member']);
  });

  it('lets a member become an owner, recorded in the audit log', async () => {
    const user = await createUser();
    const result = await api('POST', '/api/v1/users/me/become-lister', { token: user.token, body: { role: 'owner' } });
    expect(result.data.roles).toContain('owner');
    const logs = await sql`select action from public.audit_logs where actor_id = ${user.id}`;
    expect(logs.map((log) => log.action)).toContain('user.become_lister');
  });

  it('refuses to self-assign admin through become-lister', async () => {
    const user = await createUser();
    const result = await api('POST', '/api/v1/users/me/become-lister', { token: user.token, body: { role: 'admin' } });
    expect(result.status).toBe(422);
  });

  it('changes the password only with the current one', async () => {
    const user = await createUser();
    const wrong = await api('POST', '/api/v1/users/me/password', {
      token: user.token, body: { currentPassword: 'Wrongpass1', newPassword: 'NewPassword1' },
    });
    expect(wrong.status).toBe(401);

    const right = await api('POST', '/api/v1/users/me/password', {
      token: user.token, body: { currentPassword: password, newPassword: 'NewPassword1' },
    });
    expect(right.status).toBe(204);
    const login = await api('POST', '/api/v1/auth/login', { body: { email: user.email, password: 'NewPassword1' } });
    expect(login.status).toBe(200);
  });

  it('closes an account: removes personal data and blocks access', async () => {
    const user = await createUser();
    await api('PATCH', '/api/v1/users/me', { token: user.token, body: { phone: '0899999999' } });
    const closed = await api('POST', '/api/v1/users/me/deactivate', { token: user.token, body: { confirm: 'ปิดบัญชี' } });
    expect(closed.status).toBe(204);

    const [profile] = await sql`select status, phone, email from public.profiles where id = ${user.id}`;
    expect(profile).toMatchObject({ status: 'deactivated', phone: null, email: null });
    expect((await api('GET', '/api/v1/auth/me', { token: user.token })).status).toBe(403);
    expect((await api('POST', '/api/v1/auth/login', { body: { email: user.email, password } })).status).toBe(403);
  });
});
