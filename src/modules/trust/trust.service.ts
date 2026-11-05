import { LIMITS, type ReportReason, type VerificationRequest, type VerificationType } from '@rem/shared';
import { withUser, type Actor } from '@/lib/db';
import { unprocessable } from '@/lib/errors';
import { BUCKETS, newObjectName, processImage, putObject, removeObjects } from '@/lib/media';

export async function createReport(
  actor: Actor,
  input: { listingId?: string; reportedUserId?: string; reason: ReportReason; details?: string },
) {
  const [row] = await withUser(actor, (tx) => tx<{ id: string }[]>`
    insert into public.listing_reports (reporter_id, listing_id, reported_user_id, reason, details)
    values (${actor.id}, ${input.listingId ?? null}, ${input.reportedUserId ?? null},
            ${input.reason}::public.report_reason, ${input.details ?? null})
    returning id`);
  return { id: row!.id };
}

const PDF_MAGIC = Buffer.from('%PDF-');

async function storeDocument(userId: string, file: File): Promise<string> {
  const base = `${userId}/${newObjectName()}`;
  if (file.type === 'application/pdf') {
    if (file.size > LIMITS.documentMaxBytes) throw unprocessable('ไฟล์ต้องมีขนาดไม่เกิน 4 MB', 'FILE_TOO_LARGE');
    const body = Buffer.from(await file.arrayBuffer());
    if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw unprocessable('ไฟล์นี้ไม่ใช่ PDF ที่ถูกต้อง', 'INVALID_DOCUMENT');
    }
    await putObject(BUCKETS.documents, `${base}.pdf`, body, 'application/pdf');
    return `${base}.pdf`;
  }
  const image = await processImage(file, LIMITS.documentMaxBytes);
  await putObject(BUCKETS.documents, `${base}.webp`, image.full, 'image/webp');
  return `${base}.webp`;
}

export async function createVerificationRequest(
  actor: Actor,
  input: { type: VerificationType; note?: string; files: File[] },
) {
  if (input.files.length === 0 || input.files.length > 5) {
    throw unprocessable('กรุณาแนบเอกสาร 1 ถึง 5 ไฟล์', 'INVALID_UPLOAD');
  }
  const paths: string[] = [];
  try {
    for (const file of input.files) paths.push(await storeDocument(actor.id, file));
    const [row] = await withUser(actor, (tx) => tx<{ id: string }[]>`
      insert into public.verification_requests (user_id, type, document_paths, note)
      values (${actor.id}, ${input.type}::public.verification_type, ${paths}, ${input.note ?? null})
      returning id`);
    return { id: row!.id };
  } catch (error) {
    await removeObjects(BUCKETS.documents, paths);
    throw error;
  }
}

export const myVerificationRequests = (actor: Actor) => withUser(actor, async (tx) => [
  ...await tx<VerificationRequest[]>`
    select id, user_id, type, status, note, review_note, created_at
    from public.verification_requests where user_id = ${actor.id} order by created_at desc`,
]);
