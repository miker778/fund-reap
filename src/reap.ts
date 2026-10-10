// Cliente de Reap Agentic. El agente nunca ve la tarjeta: Reap la guarda y cada cargo se aprueba en su página.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { replay, reapReplay } from './replay.js';

export class ReapError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

export type Money = { amount: number; currency: string };

export type Quote = {
  id: string;
  shippingOptions: { id: string; name: string; selected: boolean; price: Money }[];
  amountBreakdown: {
    itemsSubtotal: Money;
    shipping?: Money;
    tax?: { amount: Money; includedInPrices?: boolean };
    discounts: { name: string; amount: Money }[];
    additionalCharges: { name: string; amount: Money }[];
    finalAmount: Money;
  };
  expiresAt: string;
};

export type Checkout = {
  id: string;
  status: 'REQUIRES_ACTION' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  quoteId?: string;
  orderId?: string | null;
  amount?: Money;
  finalAmount?: Money;
  nextAction?: { type: 'REDIRECT'; url: string; expiresAt?: string } | null;
};

export type Address = {
  firstName: string;
  lastName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
};

// 503 y 429 del sandbox son intermitentes: se reintenta con espera. Las escrituras llevan Idempotency-Key, así que
// reintentar no duplica nada.
async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  if (replay) return reapReplay<T>(method, path, body);
  for (let intento = 0; ; intento++) {
    try {
      return await callUnaVez<T>(method, path, body, extra);
    } catch (e) {
      if (e instanceof ReapError && (e.status === 503 || e.status === 429) && intento < 3) {
        await new Promise(r => setTimeout(r, 600 * 2 ** intento + Math.random() * 300));
        continue;
      }
      throw e;
    }
  }
}

async function callUnaVez<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.reapApiKey()}`,
    'Reap-Version': '2025-02-14',
    Accept: 'application/json',
    ...extra,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${config.reapBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no es JSON */ }
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ReapError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? text.slice(0, 300), err.detail);
  }
  return json as T;
}

const idem = (key?: string) => ({ 'Idempotency-Key': key ?? randomUUID() });

export const reap = {
  createEnrollment(owner: { id: string; email: string; name?: string }, returnUrl: string, key?: string) {
    return call<any>('POST', '/agentic/enrollments', {
      source: 'EXTERNAL',
      owner: { type: 'CLIENT_REFERENCE', id: owner.id, email: owner.email, ...(owner.name ? { name: owner.name } : {}) },
      presentation: { type: 'REDIRECT', returnUrl },
    }, idem(key));
  },
  getEnrollment(id: string) {
    return call<any>('GET', `/agentic/enrollments/${id}`);
  },
  listEnrollments(ownerId: string) {
    return call<any>('GET', `/agentic/enrollments?ownerType=CLIENT_REFERENCE&ownerId=${encodeURIComponent(ownerId)}`);
  },
  search(query: string, opts: { merchantName?: string; mode?: 'PREFER' | 'ONLY'; maxPrice?: number; country?: string; limit?: number } = {}) {
    return call<any>('POST', '/agentic/products/search', {
      query,
      ...(opts.merchantName ? { merchantPreference: { mode: opts.mode ?? 'ONLY', merchantName: opts.merchantName } } : {}),
      ...(opts.country ? { context: { country: opts.country } } : {}),
      // El filtro de precio de Reap devuelve 503 en el sandbox (2026-10-09); el precio se filtra de nuestro lado.
      filters: { availability: 'AVAILABLE_ONLY' },
      pagination: { limit: opts.limit ?? 10 },
    });
  },
  details(productIds: string[]) {
    return call<any>('POST', '/agentic/products/details', { productIds });
  },
  variant(productId: string, optionIds: string[]) {
    return call<any>('POST', '/agentic/products/variant', { productId, optionIds });
  },
  createQuote(email: string, items: { variantId: string; quantity: number }[], shippingAddress?: Address, key?: string) {
    return call<Quote>('POST', '/agentic/quotes', { email, items, ...(shippingAddress ? { shippingAddress } : {}) }, idem(key));
  },
  getQuote(id: string) {
    return call<Quote>('GET', `/agentic/quotes/${id}`);
  },
  selectShipping(quoteId: string, shippingOptionId: string) {
    return call<Quote>('POST', `/agentic/quotes/${quoteId}/shipping-option`, { shippingOptionId });
  },
  createCheckout(quoteId: string, enrollmentId: string, returnUrl: string, opts: { key?: string; simulate?: 'COMPLETED' | 'FAILED' } = {}) {
    return call<Checkout>('POST', '/agentic/checkouts', {
      quoteId, enrollmentId, presentation: { type: 'REDIRECT', returnUrl },
    }, { ...idem(opts.key), ...(opts.simulate ? { 'X-Simulate-Checkout': opts.simulate } : {}) });
  },
  getCheckout(id: string) {
    return call<Checkout>('GET', `/agentic/checkouts/${id}`);
  },
};
