'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime, localized } from '@events/shared';
import { useAction, useApp, useGet, useTr } from '@events/web-kit/client';
import { Button, Card, Empty, ErrorBox, Loading, Money, Notice, Page } from '@events/web-kit/ui';
import { RequireCustomer } from '@/lib/account';
import { EventPicker } from '@/lib/events';

type Item = {
  id: string; serviceId: string; start: string; end: string; guests: number | null; serviceTitle: Record<string, string> | null; packageName: Record<string, string> | null;
  quotedTotal: string; currentTotal: string | null; currency: string; upfrontAmount: string | null; balanceDueAt: string | null; requiresProviderApproval: boolean | null;
  cancellationPolicy: { description: Record<string, string> } | null; state: string; problem: string | null; eventId: string | null;
};
type Coupon = { totalDiscount: string; items: { itemId: string; discount: string; totalAfterDiscount: string; currency: string }[] };

export default function CartPage() {
  return <RequireCustomer><Cart /></RequireCustomer>;
}

function Cart() {
  const tr = useTr();
  const { api, lang } = useApp();
  const router = useRouter();
  const qc = useQueryClient();
  const { data, error, isLoading } = useGet<{ items: Item[]; totals: Record<string, { total: string; upfront: string }> }>('/v1/cart');
  const remove = useAction((a, id: string) => a.del(`/v1/cart/items/${id}`));
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [key] = useState(() => crypto.randomUUID());
  if (isLoading) return <Loading />;
  const items = data?.items ?? [];
  const ok = items.filter((i) => i.state === 'ok');
  const checkout = async () => {
    setBusy(true); setErr(null);
    try {
      const o = await api.post<{ id: string }>('/v1/checkout', { acceptTerms: accept, itemIds: ok.map((i) => i.id), ...(coupon ? { couponCode: code } : {}) }, { 'idempotency-key': key });
      await qc.invalidateQueries();
      router.push(`/orders/${o.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Page title={tr({ ar: 'السلة', en: 'Cart' })}>
      <ErrorBox error={error ?? remove.error ?? err} />
      {!items.length ? <Empty>{tr({ ar: 'السلة فارغة.', en: 'Your cart is empty.' })} <Link href="/search">{tr({ ar: 'تصفح الخدمات', en: 'Browse services' })}</Link></Empty> : <>
        {items.map((i) => {
          const d = coupon?.items.find((x) => x.itemId === i.id);
          return (
            <Card key={i.id} title={<Link href={`/services/${i.serviceId}`}>{localized(i.serviceTitle ?? {}, lang)}{i.packageName ? ` — ${localized(i.packageName, lang)}` : ''}</Link>}
              actions={<Button variant="ghost" onClick={() => remove.mutate(i.id)}>{tr({ ar: 'إزالة', en: 'Remove' })}</Button>}>
              <p className="muted">{formatDateTime(i.start, lang)} → {formatDateTime(i.end, lang)}{i.guests ? ` · ${i.guests} ${tr({ ar: 'ضيف', en: 'guests' })}` : ''}</p>
              {i.state === 'price_changed' && <Notice kind="warning">{tr({ ar: 'تغير السعر منذ أضفته:', en: 'The price changed since you added it:' })} <Money amount={i.quotedTotal} currency={i.currency} /> → <Money amount={i.currentTotal} currency={i.currency} /></Notice>}
              {i.state === 'unavailable' && <Notice kind="warning">{tr({ ar: 'الموعد لم يعد متاحًا؛ أزله واختر موعدًا آخر.', en: 'This slot is no longer available; remove it and pick another.' })}</Notice>}
              {i.state === 'not_bookable' && <Notice kind="warning">{tr({ ar: 'لا يمكن حجز هذه الخدمة حاليًا.', en: 'This service cannot be booked right now.' })} {i.problem}</Notice>}
              {i.currentTotal && (
                <div className="row gap">
                  <span>{tr({ ar: 'الإجمالي', en: 'Total' })}: <strong><Money amount={d ? d.totalAfterDiscount : i.currentTotal} currency={i.currency} /></strong></span>
                  {d && Number(d.discount) > 0 && <span className="badge badge-ok">−<Money amount={d.discount} currency={i.currency} /></span>}
                  <span className="muted">{tr({ ar: 'المطلوب الآن', en: 'Due now' })}: <Money amount={i.upfrontAmount} currency={i.currency} /></span>
                  {i.balanceDueAt && <span className="muted">{tr({ ar: 'المتبقي حتى', en: 'Balance by' })} {formatDate(i.balanceDueAt, lang)}</span>}
                  {i.requiresProviderApproval && <span className="badge badge-warn">{tr({ ar: 'يدفع بعد تأكيد صاحب الخدمة', en: 'Pay after provider confirms' })}</span>}
                </div>
              )}
              {i.cancellationPolicy && <p className="small muted">{tr({ ar: 'سياسة الإلغاء:', en: 'Cancellation policy:' })} {localized(i.cancellationPolicy.description, lang)}</p>}
              <EventPicker value={i.eventId} path={`/v1/cart/items/${i.id}`} testId={`cart-event-${i.id}`} />
            </Card>
          );
        })}
        <Card title={tr({ ar: 'إتمام الطلب', en: 'Place order' })}>
          <div className="row gap" style={{ marginBottom: 12 }}>
            <input name="coupon" placeholder={tr({ ar: 'رمز الكوبون', en: 'Coupon code' })} value={code} onChange={(e) => { setCode(e.target.value); setCoupon(null); }} style={{ maxWidth: 220 }} />
            <Button variant="secondary" disabled={code.trim().length < 3} onClick={async () => {
              setErr(null);
              try { setCoupon(await api.post<Coupon>('/v1/cart/coupon', { code, itemIds: ok.map((i) => i.id) })); } catch (e) { setErr(e); }
            }}>{tr({ ar: 'تطبيق', en: 'Apply' })}</Button>
            {coupon && <span className="badge badge-ok">{tr({ ar: 'خصم', en: 'Discount' })} {coupon.totalDiscount}</span>}
          </div>
          {Object.entries(data?.totals ?? {}).map(([cur, t]) => (
            <p key={cur}>{tr({ ar: 'الإجمالي', en: 'Total' })} ({cur}): <strong><Money amount={t.total} currency={cur} /></strong> · {tr({ ar: 'المطلوب الآن', en: 'Due now' })}: <Money amount={t.upfront} currency={cur} /></p>
          ))}
          <label className="check" style={{ margin: '8px 0' }}>
            <input id="accept" type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            {tr({ ar: 'أوافق على شروط الحجز وسياسات الإلغاء المعروضة', en: 'I accept the booking terms and the cancellation policies shown' })}
            <a href="/terms" target="_blank" rel="noopener noreferrer">({tr({ ar: 'الشروط', en: 'terms' })})</a>
          </label>
          <Notice>{tr({ ar: 'عند إتمام الطلب يُحجز الموعد مؤقتًا لفترة محدودة حتى يتم الدفع.', en: 'Placing the order holds the slot temporarily until payment.' })}</Notice>
          <Button variant="primary" disabled={!accept || !ok.length || busy} onClick={checkout}>{tr({ ar: 'إتمام الطلب', en: 'Place order' })}</Button>
        </Card>
      </>}
    </Page>
  );
}
