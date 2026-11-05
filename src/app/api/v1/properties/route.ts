import { propertySearchQuery } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { searchProperties } from '@/modules/catalog/catalog.service';

export const GET = route({ query: propertySearchQuery }, async ({ query }) => ok(await searchProperties(query.q)));
