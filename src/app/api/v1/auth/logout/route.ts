import { noContent, route } from '@/lib/http';
import { logout } from '@/modules/auth/auth.service';

export const POST = route({ auth: 'required' }, async ({ req }) => {
  const token = req.headers.get('authorization')?.slice(7) ?? '';
  await logout(token);
  return noContent();
});
