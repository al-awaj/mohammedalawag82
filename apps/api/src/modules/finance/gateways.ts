import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../lib/errors.js';

export interface GatewayEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | string;
  externalRef: string;
  amount: string;
  currency: string;
  fee: string;
  failureReason: string | null;
}

export interface CheckoutSession { externalRef: string; checkoutUrl: string }

export interface IntegrationRow {
  id: string;
  provider_code: string;
  environment: 'test' | 'production';
  secret_ref: string;
  config: Record<string, unknown>;
  is_active: boolean;
}

/**
 * Contract every payment provider adapter implements. Webhooks are only trusted after the
 * provider's signature is verified with the secret (clause 36); secrets come from the environment.
 */
export interface GatewayAdapter {
  readonly code: string;
  createCheckout(i: IntegrationRow, secret: string, p: { paymentId: string; number: string; amount: string; currency: string }): Promise<CheckoutSession>;
  parseWebhook(i: IntegrationRow, secret: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): { valid: boolean; event: GatewayEvent | null };
  test(i: IntegrationRow, secret: string): Promise<{ ok: boolean; message: string }>;
}

/**
 * Sandbox provider for development and automated tests. It behaves like a real gateway
 * (opaque references, HMAC-SHA256 signed webhooks) but moves no money, and is refused in production.
 */
const sandbox: GatewayAdapter = {
  code: 'sandbox',
  async createCheckout(i, _secret, p) {
    const externalRef = `sbx_${randomBytes(12).toString('hex')}`;
    const base = typeof i.config.checkoutBaseUrl === 'string' ? i.config.checkoutBaseUrl : 'https://sandbox.invalid/checkout/';
    return { externalRef, checkoutUrl: `${base}${externalRef}?amount=${p.amount}&currency=${p.currency}` };
  },
  parseWebhook(_i, secret, rawBody, headers) {
    const sig = headers['x-sandbox-signature'];
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const valid = typeof sig === 'string' && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!valid) return { valid: false, event: null };
    const body = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string; data: { reference: string; amount: string; currency: string; fee?: string; reason?: string } };
    return {
      valid: true,
      event: { id: body.id, type: body.type, externalRef: body.data.reference, amount: body.data.amount, currency: body.data.currency, fee: body.data.fee ?? '0', failureReason: body.data.reason ?? null },
    };
  },
  async test(_i, secret) {
    return secret.length >= 16 ? { ok: true, message: 'sandbox secret present' } : { ok: false, message: 'secret shorter than 16 characters' };
  },
};

const ADAPTERS: Record<string, GatewayAdapter> = { sandbox };

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS);

export function adapterFor(i: IntegrationRow, nodeEnv: string): { adapter: GatewayAdapter; secret: string } {
  const adapter = ADAPTERS[i.provider_code];
  if (!adapter) throw new AppError('INTEGRATION_NOT_CONFIGURED', 409, { reason: `no adapter for ${i.provider_code}` });
  if (adapter.code === 'sandbox' && (i.environment !== 'test' || nodeEnv === 'production')) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 409, { reason: 'the sandbox provider cannot be used in production' });
  }
  const secret = process.env[i.secret_ref];
  if (!secret) throw new AppError('INTEGRATION_NOT_CONFIGURED', 409, { reason: `environment variable ${i.secret_ref} is not set` });
  return { adapter, secret };
}
