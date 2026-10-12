import { z } from 'zod';

export const phoneSchema = z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'E.164 phone number, e.g. +966500000000');
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
export const passwordSchema = z.string().min(10).max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'must contain letters and digits');
export const langSchema = z.string().regex(/^[a-z]{2}$/);
export const uuidSchema = z.uuid();
export const i18nTextSchema = z.record(langSchema, z.string().trim().min(1).max(2000))
  .refine((v) => typeof v.ar === 'string' || typeof v.en === 'string', 'must include "ar" or "en"');
export const reasonSchema = z.string().trim().min(3).max(2000);
export const idParams = z.object({ id: uuidSchema });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
