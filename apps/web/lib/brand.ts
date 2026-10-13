/** Platform name, set per deployment at build time (NEXT_PUBLIC_BRAND_AR / NEXT_PUBLIC_BRAND_EN). */
export const BRAND = {
  ar: process.env.NEXT_PUBLIC_BRAND_AR || 'مناسبات',
  en: process.env.NEXT_PUBLIC_BRAND_EN || 'Occasions',
};
