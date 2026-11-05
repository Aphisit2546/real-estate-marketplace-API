import { ok, route } from '@/lib/http';
import { listCategories } from '@/modules/catalog/catalog.service';

export const GET = route({}, async () => ok(await listCategories()));
