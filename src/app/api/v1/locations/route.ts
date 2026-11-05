import { locationsQuery } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { listLocations } from '@/modules/catalog/catalog.service';

export const GET = route({ query: locationsQuery }, async ({ query }) =>
  ok(await listLocations(query.level, query.parentId)));
