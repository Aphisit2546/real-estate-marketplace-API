import { ok, route } from '@/lib/http';
import { listAmenities } from '@/modules/catalog/catalog.service';

export const GET = route({}, async () => ok(await listAmenities()));
