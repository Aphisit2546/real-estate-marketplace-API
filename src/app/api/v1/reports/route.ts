import { createReportSchema } from '@rem/shared';
import { created, route } from '@/lib/http';
import { createReport } from '@/modules/trust/trust.service';

export const POST = route(
  { auth: 'required', body: createReportSchema, rateLimit: { name: 'report', max: 20, windowSeconds: 3600 } },
  async ({ actor, body }) => created(await createReport(actor, body)),
);
