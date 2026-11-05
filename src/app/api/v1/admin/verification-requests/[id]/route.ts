import { adminReviewVerificationSchema, idParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { reviewVerification } from '@/modules/admin/admin.service';

export const PATCH = route(
  { auth: 'required', role: 'admin', params: idParam, body: adminReviewVerificationSchema },
  async ({ actor, params, body, ip }) => {
    await reviewVerification(actor, params.id, body.status, body.note, ip);
    return noContent();
  },
);
