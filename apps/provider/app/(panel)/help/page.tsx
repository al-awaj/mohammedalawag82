'use client';
import { localized } from '@events/shared';
import { useApp, useGet, useTr } from '@events/web-kit/client';
import { Card, ErrorBox, Loading, Page } from '@events/web-kit/ui';
import { useProvider } from '@/lib/provider';

type Article = { id: string; topic: string; question: Record<string, string>; answer: Record<string, string> };

/** Questions and answers the administration publishes for providers in their country. */
export default function Help() {
  const tr = useTr();
  const { lang } = useApp();
  const { provider } = useProvider();
  const { data, error, isLoading } = useGet<Article[]>(provider ? `/v1/help?country=${provider.countryCode}&audience=provider` : null);
  if (isLoading || !provider) return <Loading />;
  return (
    <Page title={tr({ ar: 'المساعدة والأسئلة الشائعة', en: 'Help & FAQ' })}>
      <ErrorBox error={error} />
      <Card>
        {!data?.length && <p className="muted">{tr({ ar: 'لا توجد أسئلة منشورة بعد.', en: 'Nothing published yet.' })}</p>}
        {data?.map((a) => (
          <details key={a.id} style={{ borderTop: '1px solid var(--border)', paddingBlock: 10 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{localized(a.question, lang)}</summary>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{localized(a.answer, lang)}</div>
          </details>
        ))}
        <p className="muted small">{tr({ ar: 'لم تجد إجابتك؟ افتح شكوى من «النزاعات والشكاوى».', en: 'Didn’t find your answer? Open a complaint from “Disputes & complaints”.' })}</p>
      </Card>
    </Page>
  );
}
