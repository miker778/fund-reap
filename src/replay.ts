// Modo replay (REPLAY=1): Reap y Kwal simulados localmente con el catálogo oficial de comercios, para revisar el
// producto completo sin llaves del sandbox (que vencen). Mismas respuestas y formas que la API real, mismos flujos:
// búsqueda dentro de las reglas, cotización con envío, checkout con página de aprobación, pago desde la bóveda.
import { randomUUID } from 'node:crypto';
import { comercios } from './catalogo.js';

export const replay = process.env.REPLAY === '1';

const checkouts = new Map<string, { id: string; quoteId: string; enrollmentId: string; monto: number; moneda: string; status: string; orderId: string | null }>();
const quotes = new Map<string, any>();
const productos = new Map<string, { dominio: string; nombre: string; precio: number; moneda: string; variante: string }>();

function prodsDe(dominio: string) {
  // El producto de prueba oficial de cada tienda, más dos versiones más baratas, para que un permiso típico tenga
  // opciones que caben, otras que piden aprobación y otras que se bloquean.
  const c = comercios.find(x => x.dominio === dominio);
  if (!c) return [];
  const base = c.precio || 49.99;
  const nombre = c.productoPrueba || `Producto de ${dominio}`;
  return [['Basic', 0.3], ['Standard', 0.55], ['', 1]].map(([etq, f], i) => {
    const id = `prd_replay_${Buffer.from(dominio).toString('hex').slice(0, 12)}_${i}`;
    productos.set(id, { dominio, nombre: etq ? `${nombre} (${etq})` : nombre, precio: Math.round(base * (f as number) * 100) / 100, moneda: c.moneda, variante: `var_replay_${id.slice(-14)}` });
    return id;
  });
}

// ---------- Reap Agentic simulado ----------
export async function reapReplay<T>(method: string, path: string, body: any): Promise<T> {
  const r = (x: unknown) => x as T;
  if (method === 'GET' && path.startsWith('/agentic/enrollments/')) return r({ id: path.split('/').pop(), status: 'ACTIVE', paymentMethod: { type: 'CARD', network: 'VISA', last4: '2017', expiryMonth: 12, expiryYear: 2030 } });
  if (path === '/agentic/products/search') {
    const dominio = body?.merchantPreference?.merchantName;
    const ids = dominio ? prodsDe(dominio) : [];
    return r({ id: randomUUID(), products: ids.map(id => { const p = productos.get(id)!; return { id, merchant: { name: p.dominio }, name: p.nombre, imageUrl: null, priceRange: { min: { amount: p.precio, currency: p.moneda }, max: { amount: p.precio, currency: p.moneda } }, available: true, previewVariant: { id: p.variante, name: null, price: { amount: p.precio, currency: p.moneda }, available: true } }; }), pagination: { nextCursor: null, hasNextPage: false, returnedCount: ids.length }, warnings: [] });
  }
  if (path === '/agentic/products/details') {
    return r({ products: (body?.productIds ?? []).map((id: string) => { const p = productos.get(id)!; return { id, merchant: { name: p.dominio }, name: p.nombre, description: '', media: [], options: [], defaultVariant: { id: p.variante, name: null, options: [], price: { amount: p.precio, currency: p.moneda }, available: true, requiresShipping: true, media: [] } }; }), errors: [] });
  }
  if (method === 'POST' && path === '/agentic/quotes') {
    const v = body.items[0].variantId;
    const p = [...productos.values()].find(x => x.variante === v)!;
    const id = randomUUID();
    const q = { id, shippingOptions: [{ id: 'std', name: 'Standard', selected: true, price: { amount: 6, currency: p.moneda } }, { id: 'exp', name: 'Express', selected: false, price: { amount: 23, currency: p.moneda } }],
      amountBreakdown: { itemsSubtotal: { amount: p.precio, currency: p.moneda }, shipping: { amount: 6, currency: p.moneda }, tax: { amount: { amount: 0, currency: p.moneda }, includedInPrices: false }, discounts: [], additionalCharges: [], finalAmount: { amount: Math.round((p.precio + 6) * 100) / 100, currency: p.moneda } },
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    quotes.set(id, q); return r(q);
  }
  if (method === 'POST' && path.endsWith('/shipping-option')) return r(quotes.get(path.split('/')[3]));
  if (method === 'GET' && path.startsWith('/agentic/quotes/')) return r(quotes.get(path.split('/').pop()!));
  if (method === 'POST' && path === '/agentic/checkouts') {
    const q = quotes.get(body.quoteId);
    const id = randomUUID();
    const c = { id, quoteId: body.quoteId, enrollmentId: body.enrollmentId, monto: q.amountBreakdown.finalAmount.amount, moneda: q.amountBreakdown.finalAmount.currency, status: 'REQUIRES_ACTION', orderId: null };
    checkouts.set(id, c);
    const base = process.env.PUBLIC_URL ?? 'http://127.0.0.1:3066';
    return r({ id, status: c.status, quoteId: c.quoteId, enrollmentId: c.enrollmentId, amount: { amount: c.monto, currency: c.moneda }, nextAction: { type: 'REDIRECT', url: `${base}/replay/aprobar/${id}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() } });
  }
  if (method === 'GET' && path.startsWith('/agentic/checkouts/')) {
    const c = checkouts.get(path.split('/').pop()!);
    if (!c) throw new Error('checkout desconocido');
    return r({ id: c.id, status: c.status, quoteId: c.quoteId, enrollmentId: c.enrollmentId, orderId: c.orderId, finalAmount: { amount: c.monto, currency: c.moneda }, nextAction: c.status === 'REQUIRES_ACTION' ? { type: 'REDIRECT', url: `/replay/aprobar/${c.id}` } : null });
  }
  if (method === 'GET' && path.startsWith('/agentic/enrollments')) return r({ items: [], nextCursor: null });
  throw new Error(`replay: ruta de Reap no simulada ${method} ${path}`);
}

// La "página de aprobación" local: en el sandbox real es la página de Reap con passkey.
export function aprobarReplay(id: string) {
  const c = checkouts.get(id);
  if (!c) return false;
  c.status = 'COMPLETED';
  c.orderId = 'ord_replay_' + id.slice(0, 8);
  return true;
}

// ---------- Kwal simulado: la bóveda paga sin passkey ----------
const kwalQuotes = new Map<string, number>();
export async function kwalReplay(method: string, path: string, body: any): Promise<{ status: number; body: any }> {
  const ok = (b: any) => ({ status: 200, body: b });
  if (path.startsWith('/kwal/participant/v1/products?')) {
    const doms = comercios.filter(c => c.moneda === 'USD' && ['Jewellery & Watches', 'Computers & Electronics'].includes(c.categoria)).slice(0, 6);
    return ok({ products: doms.map(d => ({ productId: 'kprd_' + d.dominio, title: d.productoPrueba || d.dominio, merchant: d.dominio.split('.')[0], price: { minorUnits: '395', currency: 'USD', decimals: 2 } })) });
  }
  if (method === 'GET' && path.startsWith('/kwal/participant/v1/products/')) return ok({ product: {}, options: [] });
  if (path.endsWith('/variant')) return ok({ variantId: 'kvar_' + path.split('/')[4], purchasable: true, price: { minorUnits: '395', currency: 'USD', decimals: 2 } });
  if (method === 'POST' && path === '/kwal/participant/v1/quotes') { const id = randomUUID(); kwalQuotes.set(id, 3.95); return ok({ quoteId: id, total: { minorUnits: '395', currency: 'USD', decimals: 2 }, subtotal: { minorUnits: '395', currency: 'USD', decimals: 2 }, shipping: { minorUnits: '0', currency: 'USD', decimals: 2 }, tax: { minorUnits: '0', currency: 'USD', decimals: 2 } }); }
  if (path.startsWith('/kwal/participant/v1/funding')) return ok({ state: 'PARTICIPANT_FUNDING_STATE_READY', available: { minorUnits: '10000000' }, shortfall: { minorUnits: '0' }, required: { minorUnits: '3950000' } });
  if (method === 'POST' && path === '/kwal/participant/v1/payments') return ok({ paymentId: body.paymentId, state: 'PARTICIPANT_PAYMENT_STATE_PENDING' });
  if (method === 'GET' && path.startsWith('/kwal/participant/v1/payments/')) return ok({ state: 'PARTICIPANT_PAYMENT_STATE_COMPLETED', step: 'card_clearing', orderId: null, charged: { minorUnits: '3950000', currency: 'USDC', decimals: 6 }, reason: 'paid from your vault by a simulated card spend; nothing ships' });
  return { status: 404, body: { error: 'replay: ruta de Kwal no simulada' } };
}
