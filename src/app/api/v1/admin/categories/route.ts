import { adminCategorySchema } from '@rem/shared';
import { created, ok, route } from '@/lib/http';
import { allCategories, saveCategory } from '@/modules/admin/admin.service';

export const GET = route({ auth: 'required', role: 'admin' }, async () => ok(await allCategories()));
export const POST = route({ auth: 'required', role: 'admin', body: adminCategorySchema }, async ({ actor, body, ip }) =>
  created(await saveCategory(actor, null, body, ip)));
