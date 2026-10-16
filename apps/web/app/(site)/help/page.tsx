import type { Metadata } from 'next';
import { localized } from '@events/shared';
import { currentCountry, publicGet, visitor } from '@/lib/server';

export const metadata: Metadata = { title: 'المساعدة والأسئلة الشائعة' };
type Article = { id: string; topic: string; question: Record<string, string>; answer: Record<string, string> };

/** Help centre: questions and answers published by the administration for customers in the visitor's country. */
export default async function Help() {
  const { lang, country: code } = await visitor();
  const { country } = await currentCountry(lang, code);
  const ar = lang === 'ar';
  const articles = country ? (await publicGet<Article[]>(`/v1/help?country=${country.code}&audience=customer`, lang)) ?? [] : [];
  const topics = [...new Set(articles.map((a) => a.topic))];
  return (
    <article className="card" data-testid="help-page">
      <h1>{ar ? 'المساعدة والأسئلة الشائعة' : 'Help & FAQ'}</h1>
      {topics.length === 0 && <p className="muted">{ar ? 'لا توجد أسئلة منشورة بعد.' : 'Nothing published yet.'}</p>}
      {topics.map((t) => (
        <section key={t}>
          {articles.filter((a) => a.topic === t).map((a) => (
            <details key={a.id} className="faq">
              <summary>{localized(a.question, lang)}</summary>
              <div style={{ whiteSpace: 'pre-wrap' }}>{localized(a.answer, lang)}</div>
            </details>
          ))}
        </section>
      ))}
      <p className="muted small">{ar ? 'لم تجد إجابتك؟ ' : 'Didn’t find your answer? '}<a href="/account/disputes">{ar ? 'تواصل مع الدعم' : 'Contact support'}</a></p>
    </article>
  );
}
