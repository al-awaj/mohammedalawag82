import { Armchair, Building2, Cake, Camera, Car, Crown, Flower2, Gift, Lightbulb, Mic, Music, Palette, Shirt, Sparkles, Tent, UtensilsCrossed, type LucideIcon } from 'lucide-react';

/** Picks an icon for a category from its slug or name (admins name categories freely; unknown ones get a neutral icon). */
const RULES: [RegExp, LucideIcon][] = [
  [/hall|venue|قاع|صال|فندق|hotel/i, Building2],
  [/photo|video|تصوير|مصور|فيديو/i, Camera],
  [/cater|food|buffet|ضياف|بوفيه|طعام|مطبخ|قهو/i, UtensilsCrossed],
  [/cake|sweet|dessert|كيك|حلو/i, Cake],
  [/flower|decor|stage|ورد|زهور|تنسيق|كوش|ديكور/i, Flower2],
  [/tent|camp|خيم|مخيم/i, Tent],
  [/music|band|zaff|dj|فرق|زف|طرب|موسيق/i, Music],
  [/light|sound|audio|إضاء|اضاء|صوت/i, Lightbulb],
  [/mc|host|مقدم|تقديم/i, Mic],
  [/car|limo|سيار|نقل/i, Car],
  [/dress|fashion|فستان|أزياء|ازياء/i, Shirt],
  [/beauty|makeup|تجميل|مكياج|ميك/i, Palette],
  [/furniture|chair|كراس|أثاث|اثاث|تأجير|rental/i, Armchair],
  [/gift|توزيع|هدايا|هدية/i, Gift],
  [/vip|luxury|ملكي|فاخر/i, Crown],
];

export function categoryIcon(...hints: (string | undefined | null)[]): LucideIcon {
  const text = hints.filter(Boolean).join(' ');
  return RULES.find(([re]) => re.test(text))?.[1] ?? Sparkles;
}

/** Stable accent per category so the grid is colourful without any per-category setting. */
const TONES = ['tone-violet', 'tone-rose', 'tone-amber', 'tone-teal', 'tone-sky', 'tone-fuchsia', 'tone-emerald', 'tone-orange'];
export function categoryTone(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
}
