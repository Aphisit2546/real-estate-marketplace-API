export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'กรุณาเข้าสู่ระบบ', code = 'UNAUTHORIZED') => new ApiError(401, code, message);
export const forbidden = (message = 'คุณไม่มีสิทธิ์ดำเนินการนี้', code = 'FORBIDDEN') => new ApiError(403, code, message);
export const notFound = (message = 'ไม่พบข้อมูล') => new ApiError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message);
export const unprocessable = (message: string, code = 'UNPROCESSABLE', details?: unknown) =>
  new ApiError(422, code, message, details);
export const rateLimited = () => new ApiError(429, 'RATE_LIMITED', 'ส่งคำขอถี่เกินไป กรุณาลองใหม่ภายหลัง');

const UNIQUE_MESSAGES: Record<string, string> = {
  listings_one_active_per_unit_key: 'ห้องนี้มีประกาศที่ยังใช้งานอยู่แล้ว',
  listings_no_duplicate_title_key: 'คุณมีประกาศชื่อนี้ที่ยังใช้งานอยู่แล้ว',
  appointments_one_active_key: 'คุณมีนัดหมายของประกาศนี้อยู่แล้ว',
  listing_reports_one_open_key: 'คุณรายงานประกาศนี้ไปแล้ว',
  verification_requests_one_pending_key: 'คุณมีคำขอที่รอตรวจสอบอยู่แล้ว',
};

interface PgLikeError { code?: string; constraint_name?: string; constraintName?: string }

/** Translates database errors so raw SQL details never reach a client. */
export function fromDatabaseError(error: unknown): ApiError | null {
  const pg = error as PgLikeError;
  if (typeof pg?.code !== 'string' || pg.code.length !== 5) return null;
  const constraint = pg.constraint_name ?? pg.constraintName ?? '';
  switch (pg.code) {
    case '23505':
      return conflict(UNIQUE_MESSAGES[constraint] ?? 'ข้อมูลนี้มีอยู่แล้ว', 'DUPLICATE');
    case '23503':
      return unprocessable('ข้อมูลอ้างอิงไม่ถูกต้อง', 'INVALID_REFERENCE');
    case '23514':
      return unprocessable('ข้อมูลไม่ผ่านเงื่อนไขของระบบ', 'CONSTRAINT_VIOLATION');
    case '42501':
      return forbidden();
    default:
      return null;
  }
}
