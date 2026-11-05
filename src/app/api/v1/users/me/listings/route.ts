import { adminListingsQuery } from '@rem/shared';
import { route } from '@/lib/http';
import { paged } from '@/lib/pagination';
import { myListings } from '@/modules/listings/listings.service';

export const GET = route({ auth: 'required', role: 'lister', query: adminListingsQuery }, async ({ actor, query }) => {
  const { rows, total } = await myListings(actor, query.status, query.page, query.limit);
  return paged(rows, total, query);
});
