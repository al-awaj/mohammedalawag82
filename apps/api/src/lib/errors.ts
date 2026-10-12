export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details: unknown = null,
  ) {
    super(code);
  }
}

export const badRequest = (code: string, details?: unknown) => new AppError(code, 400, details);
export const unauthorized = (code = 'AUTH_REQUIRED') => new AppError(code, 401);
export const forbidden = (code = 'FORBIDDEN') => new AppError(code, 403);
export const notFound = (code = 'NOT_FOUND') => new AppError(code, 404);
export const conflict = (code: string, details?: unknown) => new AppError(code, 409, details);

/** Postgres unique_violation -> conflict with the given code, when the constraint matches. */
export function mapUniqueViolation(err: unknown, map: Record<string, string>): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint) {
    for (const [fragment, code] of Object.entries(map)) {
      if (e.constraint.includes(fragment)) throw conflict(code);
    }
  }
  throw err;
}
