import { verificationTypeSchema } from '@rem/shared';
import { unprocessable } from '@/lib/errors';
import { created, ok, route } from '@/lib/http';
import { createVerificationRequest, myVerificationRequests } from '@/modules/trust/trust.service';

export const GET = route({ auth: 'required' }, async ({ actor }) => ok(await myVerificationRequests(actor)));

export const POST = route(
  { auth: 'required', rateLimit: { name: 'verification', max: 5, windowSeconds: 3600 } },
  async ({ actor, req }) => {
    const form = await req.formData().catch(() => {
      throw unprocessable('กรุณาส่งไฟล์แบบ multipart/form-data', 'INVALID_UPLOAD');
    });
    const type = verificationTypeSchema.safeParse(form.get('type'));
    if (!type.success) throw unprocessable('ประเภทคำขอไม่ถูกต้อง', 'VALIDATION_ERROR');
    const files = form.getAll('files').filter((value): value is File => value instanceof File);
    const note = form.get('note');
    return created(await createVerificationRequest(actor, {
      type: type.data,
      note: typeof note === 'string' && note ? note.slice(0, 1000) : undefined,
      files,
    }));
  },
);
