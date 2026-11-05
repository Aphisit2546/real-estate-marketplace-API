import { ok, route } from '@/lib/http';
import { getPublicSettings } from '@/modules/catalog/catalog.service';

export const GET = route({}, async () => ok(await getPublicSettings()));
