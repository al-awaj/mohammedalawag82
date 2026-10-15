/**
 * Error alerts (clause 75): unexpected server errors are posted to ERROR_WEBHOOK_URL (Slack, Teams, a monitoring
 * service's webhook…). Only the error class, message, route and request id are sent — never request bodies, tokens
 * or personal data. The same message is sent at most once every five minutes.
 */
const recent = new Map<string, number>();
const WINDOW_MS = 5 * 60_000;

export function reportError(source: string, err: unknown, context: { route?: string | undefined; method?: string | undefined; requestId?: string | undefined } = {}) {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  const e = err as { name?: string; message?: string; code?: string };
  const message = String(e?.message ?? err).slice(0, 500);
  const key = `${source}:${context.route ?? ''}:${message}`;
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > WINDOW_MS) recent.delete(k);
  if (recent.has(key)) return;
  recent.set(key, now);
  const body = {
    text: `[${process.env.NODE_ENV ?? 'dev'}] ${source}: ${e?.name ?? 'Error'}${e?.code ? ` (${e.code})` : ''} — ${message}${context.route ? ` @ ${context.method ?? ''} ${context.route}` : ''}`,
    source, error: e?.name ?? 'Error', code: e?.code ?? null, message, ...context, at: new Date(now).toISOString(),
  };
  void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
}
