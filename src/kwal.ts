// Cliente de Kwal (Payward): la bóveda del gastador paga sin passkey. Los pagos del sandbox son simulados.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import type { Address } from './reap.js';
import { replay, kwalReplay } from './replay.js';

const BASE = process.env.KWAL_URL ?? 'https://api.sandbox.services.payward.com';
// Un participante por distribuidor (data/kwal/<nombre>.json): cada uno con su bóveda y su tarjeta, así los pagos de
// distintos distribuidores corren en paralelo. Sin nombre se usa el participante original.
function archivo(nombre?: string) { return nombre ? `${config.dataDir}/kwal/${nombre}.json` : `${config.dataDir}/kwal-participante.json`; }
export function participante(nombre?: string): { token: string; vault?: string; owner?: string } | null {
  if (replay) return { token: 'replay', vault: '0x000000000000000000000000000000000000dEaD' };
  const f = archivo(nombre);
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return j.expiresAtUnixSeconds * 1000 > Date.now() ? j : null;
}
function token(nombre?: string): string | null { return participante(nombre)?.token ?? null; }
export const kwalDisponible = (nombre?: string) => !!token(nombre);
// El participante de cada compra viaja en el contexto asíncrono: compras paralelas de distribuidores distintos no se cruzan.
const contexto = new AsyncLocalStorage<string | undefined>();
export function con<T>(nombre: string | undefined, f: () => Promise<T>): Promise<T> { return contexto.run(nombre, f); }

async function k<T = any>(method: string, path: string, body?: unknown, nombre: string | undefined = contexto.getStore()): Promise<{ status: number; body: T }> {
  if (replay) return kwalReplay(method, path, body) as any;
  const t = token(nombre);
  if (!t) throw new Error('Kwal sin sesión');
  const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const txt = await r.text(); let j: any; try { j = JSON.parse(txt); } catch { j = txt.slice(0, 300); }
  return { status: r.status, body: j };
}

// Kwal manda minorUnits con decimals; sin decimals el número ya está en unidades enteras (79 = 79 USD).
export const monto = (x: any) => Number(x?.minorUnits ?? 0) / 10 ** Number(x?.decimals ?? 0);

// PARTICIPANT_PAYMENT_STATE_COMPLETED -> completed
const normal = (x: unknown) => String(x ?? '').replace(/^PARTICIPANT_PAYMENT_STATE_/, '').toLowerCase();

export type ProductoKwal = { productId: string; title: string; merchant: string; precio: number; moneda: string };

export async function buscar(consulta: string, limite = 8): Promise<ProductoKwal[]> {
  const r = await k('GET', `/kwal/participant/v1/products?query=${encodeURIComponent(consulta)}&limit=${limite}`);
  return (r.body?.products ?? []).map((p: any) => ({ productId: p.productId, title: p.title, merchant: p.merchant, precio: monto(p.price), moneda: p.price?.currency }));
}

export async function variante(productId: string): Promise<{ variantId: string; precio: number } | null> {
  const d = await k('GET', `/kwal/participant/v1/products/${productId}`);
  const ids = (d.body?.options ?? []).map((o: any) => o.values?.[0]?.optionId).filter(Boolean);
  const v = await k('POST', `/kwal/participant/v1/products/${productId}/variant`, { optionIds: ids });
  if (!v.body?.variantId || v.body?.purchasable === false) return null;
  return { variantId: v.body.variantId, precio: monto(v.body.price) };
}

export async function cotizar(variantId: string, email: string, dir: Address) {
  const r = await k('POST', '/kwal/participant/v1/quotes', { email, lines: [{ variantId, quantity: 1 }], shippingAddress: { firstName: dir.firstName, lastName: dir.lastName, phone: dir.phone, line1: dir.addressLine1, ...(dir.addressLine2 ? { line2: dir.addressLine2 } : {}), city: dir.city, ...(dir.region ? { region: dir.region } : {}), ...(dir.postalCode ? { postalCode: dir.postalCode } : {}), country: dir.country } });
  if (r.status >= 400) throw new Error(`Kwal no cotizó: ${JSON.stringify(r.body).slice(0, 160)}`);
  const b = r.body;
  const m = monto;
  return { quoteId: b.quoteId as string, total: m(b.total), subtotal: m(b.subtotal), envio: m(b.shipping), impuestos: m(b.tax), moneda: b.total?.currency as string, vence: b.expiresAt as string | undefined };
}

export async function fondeo(quoteId: string) {
  const r = await k('GET', `/kwal/participant/v1/funding?quoteId=${quoteId}`);
  return { estado: String(r.body?.state ?? ''), disponible: Number(r.body?.available?.minorUnits ?? 0) / 1e6, faltan: Number(r.body?.shortfall?.minorUnits ?? 0) / 1e6, requerido: Number(r.body?.required?.minorUnits ?? 0) / 1e6 };
}

export async function pagar(quoteId: string) {
  const paymentId = `pay_${randomUUID()}`;
  const r = await k('POST', '/kwal/participant/v1/payments', { paymentId, quoteId });
  if (r.status >= 400) throw new Error(`Kwal no abrió el pago: ${JSON.stringify(r.body).slice(0, 160)}`);
  return { paymentId, estado: normal(r.body?.state), paso: r.body?.step ?? null, aprobacion: r.body?.approvalUrl ?? null };
}

export async function pago(paymentId: string) {
  const r = await k('GET', `/kwal/participant/v1/payments/${paymentId}`);
  const b = r.body ?? {};
  return { estado: normal(b.state), paso: b.step ?? null, orden: b.orderId ?? null, razon: b.reason ?? null, aprobacion: b.approvalUrl ?? null, cargado: b.charged ?? null };
}
