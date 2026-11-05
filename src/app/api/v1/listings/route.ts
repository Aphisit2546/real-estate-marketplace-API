import { createListingSchema, searchQuery } from '@rem/shared';
import { created, ok, route } from '@/lib/http';
import { createListing, search } from '@/modules/listings/listings.service';

export const GET = route({ auth: 'optional', query: searchQuery }, async ({ actor, query }) => {
  const { items, nextCursor } = await search(query, actor);
  return ok(items, { meta: { nextCursor, limit: query.limit } });
});

export const POST = route(
  {
    auth: 'required',
    role: 'lister',
    body: createListingSchema,
    rateLimit: { name: 'create-listing', max: 20, windowSeconds: 3600 },
  },
  async ({ actor, body }) => created(await createListing(actor, body)),
);
