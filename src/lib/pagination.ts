import { ok } from './http';

export function paged<T>(rows: T[], total: number, query: { page: number; limit: number }) {
  return ok(rows, {
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  });
}
