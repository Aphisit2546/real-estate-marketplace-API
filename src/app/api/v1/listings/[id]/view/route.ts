import { idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { recordView } from '@/modules/listings/listings.service';

export const POST = route(
  { params: idParam, rateLimit: { name: 'view', max: 120, windowSeconds: 60, by: 'ip' } },
  async ({ params }) => {
    await recordView(params.id);
    return noContent();
  },
);
