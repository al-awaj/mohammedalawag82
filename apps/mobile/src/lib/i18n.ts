import { useSession } from './session';

/** Inline bilingual text: tr({ ar: '…', en: '…' }). */
export function useTr() {
  const { lang } = useSession();
  return (s: { ar: string; en: string }) => s[lang];
}
