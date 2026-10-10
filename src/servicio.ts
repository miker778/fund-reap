// La lógica de Permiso. La API, el MCP y el canal de WhatsApp llaman sólo a esto.
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { db, ahora, evento } from './db.js';
import { reap, ReapError, type Address, type Quote } from './reap.js';
import { evaluar, saldo as calcSaldo, type Reglas, type Veredicto } from './reglas.js';
import { porDominio, tiendasPara } from './catalogo.js';
import { config } from './config.js';
import { decidirExcepcion, POLITICA_BASE, type Politica } from './decidir.js';
import { tiendasAtoradas } from './incidentes.js';

export class ErrorPermiso extends Error {
  constructor(public codigo: string, message: string, public http = 400) { super(message); }
}

export type Gastador = {
  nombre: string;
  email: string;
  telefono: string;          // E.164
  direccion: Address;
  enrollmentId: string;      // tarjeta guardada en Reap (la del sandbox para el demo)
};

export type Permiso = {
  id: string;
  plantilla: 'reposicion' | 'mdf';
  titulo: string;
  financiador: string;
  gastador: Gastador;
  tope: number;
  moneda: string;
  reglas: Reglas;
  contexto: Record<string, unknown>;
  vence: string;
  estado: 'activo' | 'cerrado';
  token: string;
  onchain: Record<string, unknown> | null;
  creado: string;
  cerrado: string | null;
  sobrante: number | null;
};

// Ganchos que llenan otras partes (canal de WhatsApp, contrato) sin que el servicio dependa de ellas.
export const ganchos = {
  avisarFinanciador: async (_p: Permiso, _texto: string) => {},
  avisarGastador: async (_p: Permiso, _texto: string) => {},
  onchainCrear: async (_p: Permiso): Promise<Record<string, unknown> | null> => null,
  onchainAutorizar: async (_p: Permiso, _monto: number, _cotizacionId: string): Promise<string | null> => null,
  onchainAprobar: async (_p: Permiso, _extra: number, _cotizacionId: string): Promise<string | null> => null,
  onchainRecibo: async (_p: Permiso, _compraId: string, _hash: string): Promise<string | null> => null,
  onchainCerrar: async (_p: Permiso): Promise<string | null> => null,
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const id = (pre: string, n = 6) => `${pre}_${randomBytes(n).toString('hex')}`;
const J = (s: unknown) => JSON.parse(String(s));

// ---------- plantillas ----------

export const PLANTILLAS = {
  reposicion: {
    nombre: 'Reposición en especie (aseguradora)',
    categorias: ['Audio & Music'], // reposición equivalente: misma categoría que lo que se perdió
    cantidadMax: 1,
    margenAprobacion: 0.5,
    dias: 7,
  },
  mdf: {
    nombre: 'Fondo co-op de socio (MDF)',
    categorias: ['Computers & Electronics', 'Audio & Music', 'Office & Business Supplies', 'Books & Stationery', 'Jewellery & Watches', 'Gifts & Flowers'], // equipo, oficina y merch promocional
    cantidadMax: 10,
    margenAprobacion: 0.25,
    dias: 90,
  },
} as const;

export type CrearPermiso = {
  plantilla: 'reposicion' | 'mdf';
  titulo: string;
  financiador: string;
  gastador: Omit<Gastador, 'enrollmentId'> & { enrollmentId?: string };
  tope: number;
  moneda?: string;
  contexto?: Record<string, unknown>;
  vence?: string;
  tiendas?: string[];
  categorias?: string[];
};

function fila(r: any): Permiso {
  return {
    ...r,
    gastador: J(r.gastador),
    reglas: J(r.reglas),
    contexto: J(r.contexto),
    onchain: r.onchain ? J(r.onchain) : null,
  };
}

export async function crearPermiso(input: CrearPermiso): Promise<Permiso> {
  const t = PLANTILLAS[input.plantilla];
  if (!t) throw new ErrorPermiso('plantilla', `plantilla desconocida: ${input.plantilla}`);
  if (!(input.tope > 0)) throw new ErrorPermiso('tope', 'el tope tiene que ser mayor a cero');
  const moneda = input.moneda ?? 'USD';
  const pais = input.gastador.direccion.country;
  const categorias = input.categorias ?? [...t.categorias];
  const tiendas = input.tiendas ?? tiendasPara(categorias, pais, moneda);
  if (!tiendas.length) throw new ErrorPermiso('tiendas', `ninguna tienda del catálogo cumple ${categorias.join(', ')} con envío a ${pais}`);
  const enrollmentId = input.gastador.enrollmentId ?? process.env.DEMO_ENROLLMENT_ID;
  if (!enrollmentId) throw new ErrorPermiso('tarjeta', 'el gastador no tiene tarjeta inscrita en Reap');
  const vence = input.vence ?? new Date(Date.now() + t.dias * 86400_000).toISOString();
  const p: Permiso = {
    id: id('pf', 4),
    plantilla: input.plantilla,
    titulo: input.titulo,
    financiador: input.financiador,
    gastador: { ...input.gastador, enrollmentId },
    tope: r2(input.tope),
    moneda,
    reglas: { tiendas, categorias, moneda, cantidadMax: t.cantidadMax, margenAprobacion: t.margenAprobacion, ...((input.contexto as any)?.politica ? { politica: (input.contexto as any).politica } : {}) } as any,
    contexto: input.contexto ?? {},
    vence,
    estado: 'activo',
    token: id('t', 16),
    onchain: null,
    creado: ahora(),
    cerrado: null,
    sobrante: null,
  };
  db.prepare(`INSERT INTO permisos (id, plantilla, titulo, financiador, gastador, tope, moneda, reglas, contexto, vence, estado, token, creado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.id, p.plantilla, p.titulo, p.financiador, JSON.stringify(p.gastador), p.tope, p.moneda,
    JSON.stringify(p.reglas), JSON.stringify(p.contexto), p.vence, p.estado, p.token, p.creado);
  evento(p.id, 'permiso_creado', { plantilla: p.plantilla, tope: p.tope, tiendas: tiendas.length, vence });
  try {
    const oc = await ganchos.onchainCrear(p);
    if (oc) { guardarOnchain(p.id, oc); p.onchain = oc; }
  } catch (e) {
    evento(p.id, 'onchain_error', { paso: 'crear', error: String(e) });
  }
  return p;
}

function guardarOnchain(permisoId: string, datos: Record<string, unknown>) {
  const actual = obtener(permisoId).onchain ?? {};
  db.prepare('UPDATE permisos SET onchain = ? WHERE id = ?').run(JSON.stringify({ ...actual, ...datos }), permisoId);
}

export function obtener(permisoId: string): Permiso {
  const r = db.prepare('SELECT * FROM permisos WHERE id = ?').get(permisoId);
  if (!r) throw new ErrorPermiso('no_existe', `no existe el permiso ${permisoId}`, 404);
  return fila(r);
}

export function porToken(token: string): Permiso | null {
  const r = db.prepare('SELECT * FROM permisos WHERE token = ?').get(token);
  return r ? fila(r) : null;
}

db.exec(`CREATE TABLE IF NOT EXISTS ocultos (permiso_id TEXT PRIMARY KEY)`);
// Los permisos de prueba se ocultan de la consola y del marcador; siguen en la base y en la cadena.
export function listar(incluirOcultos = false): Permiso[] {
  const sql = incluirOcultos ? 'SELECT * FROM permisos ORDER BY creado DESC' : 'SELECT * FROM permisos WHERE id NOT IN (SELECT permiso_id FROM ocultos) ORDER BY creado DESC';
  return db.prepare(sql).all().map(fila);
}
export function ocultar(ids: string[]) { const st = db.prepare('INSERT OR IGNORE INTO ocultos (permiso_id) VALUES (?)'); for (const id of ids) st.run(id); }

// Lo gastado incluye lo apartado por compras en curso, para que no se gaste dos veces.
export function gastado(permisoId: string) {
  const r = db.prepare(`SELECT COALESCE(SUM(monto), 0) AS s FROM compras WHERE permiso_id = ? AND estado IN ('REQUIRES_ACTION', 'PROCESSING', 'COMPLETED')`).get(permisoId) as any;
  return r2(r.s);
}

export function resumen(p: Permiso) {
  const g = gastado(p.id);
  const compras = db.prepare('SELECT * FROM compras WHERE permiso_id = ? ORDER BY creado').all(p.id).map((c: any) => ({ ...c, estadoTexto: estadoHumano(c.estado), recibo: c.recibo ? J(c.recibo) : null }));
  const excepciones = db.prepare('SELECT * FROM excepciones WHERE permiso_id = ? ORDER BY creado').all(p.id);
  return {
    id: p.id,
    plantilla: p.plantilla,
    titulo: p.titulo,
    financiador: p.financiador,
    gastador: { nombre: p.gastador.nombre, ciudad: p.gastador.direccion.city, pais: p.gastador.direccion.country },
    tope: p.tope,
    moneda: p.moneda,
    gastado: g,
    saldo: calcSaldo(p, g),
    vence: p.vence,
    estado: p.estado,
    reglas: { categorias: p.reglas.categorias, tiendas: p.reglas.tiendas, cantidadMax: p.reglas.cantidadMax, margenAprobacion: p.reglas.margenAprobacion },
    contexto: p.contexto,
    onchain: p.onchain,
    sobrante: p.sobrante,
    compras,
    excepciones,
  };
}

// ---------- opciones (búsqueda dentro de las reglas) ----------

const nombreADominio = new Map<string, string>();
const productoADominio = new Map<string, string>();

async function enLotes<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...await Promise.all(xs.slice(i, i + n).map(f)));
  return out;
}

export async function opciones(p: Permiso, consulta: string, tiendas?: string[]) {
  vivo(p);
  const s = calcSaldo(p, gastado(p.id));
  const donde = (tiendas?.length ? tiendas.filter(t => p.reglas.tiendas.includes(t)) : p.reglas.tiendas).slice(0, 15);
  const fallas: string[] = [];
  const res = await enLotes(donde, 4, async dominio => {
    try {
      const r = await reap.search(consulta, { merchantName: dominio, mode: 'ONLY', country: p.gastador.direccion.country, limit: 3 });
      return (r.products ?? []).map((x: any) => {
        nombreADominio.set(x.merchant.name, dominio);
        productoADominio.set(x.id, dominio);
        const precio = x.previewVariant?.price ?? x.priceRange?.min;
        return {
          productId: x.id,
          nombre: x.name,
          tienda: dominio,
          tiendaNombre: x.merchant.name,
          precio: precio?.amount,
          moneda: precio?.currency,
          imagen: x.imageUrl ?? null,
          // Reap no devuelve la URL del producto: el enlace es la búsqueda pública de la propia tienda. La compra sigue sólo por Reap.
          enlace: `https://${dominio}/search?q=${encodeURIComponent(x.name)}`,
          cabeEnSaldo: precio?.currency === p.moneda && precio?.amount <= s,
        };
      });
    } catch (e) {
      fallas.push(`${dominio}: ${e instanceof ReapError ? e.code : String(e)}`);
      return [];
    }
  });
  const limite = s * (1 + p.reglas.margenAprobacion);
  const atoradas = tiendasAtoradas();
  const lista = res.flat().filter(o => o.moneda === p.moneda && o.precio <= limite).sort((a, b) => Number(atoradas.has(a.tienda)) - Number(atoradas.has(b.tienda)) || Number(b.cabeEnSaldo) - Number(a.cabeEnSaldo) || b.precio - a.precio); // primero lo que cabe, lo más cercano al tope arriba
  evento(p.id, 'opciones', { consulta, tiendas: donde.length, resultados: lista.length, fallas });
  return { saldo: s, moneda: p.moneda, nota: 'El precio no incluye envío; la cotización da el total.', opciones: lista.slice(0, 8) };
}

// ---------- cotizar ----------

function vivo(p: Permiso) {
  if (p.estado !== 'activo') throw new ErrorPermiso('cerrado', 'el permiso está cerrado');
}

async function resolverVariante(productId: string, variantId?: string) {
  const d = await reap.details([productId]);
  const prod = d.products?.[0];
  if (!prod) throw new ErrorPermiso('producto', `Reap no encontró el producto ${productId}`);
  const dominio = productoADominio.get(productId) ?? nombreADominio.get(prod.merchant?.name) ?? null;
  const v = variantId ? { id: variantId, name: null } : prod.defaultVariant;
  return { prod, variante: v, dominio };
}

// Público (API, MCP, WhatsApp): sólo productId de nuestra búsqueda. La variante es la que Reap da por defecto y la
// tienda sale de nuestra búsqueda o del nombre de comercio que devuelve Reap, nunca de lo que mande quien llama.
export async function cotizar(p: Permiso, args: { productId: string; cantidad?: number }) {
  return cotizarInterno(p, { productId: args.productId, cantidad: args.cantidad });
}

async function cotizarInterno(p: Permiso, args: { productId: string; variantId?: string; cantidad?: number; tienda?: string }) {
  vivo(p);
  const { prod, variante, dominio: dom } = await resolverVariante(args.productId, args.variantId);
  const dominio = args.tienda ?? dom;
  if (!dominio) throw new ErrorPermiso('tienda', 'no sé de qué tienda es ese producto; búscalo primero con opciones');
  const cantidad = args.cantidad ?? 1;
  let q: Quote;
  try {
    q = await reap.createQuote(p.gastador.email, [{ variantId: variante.id, quantity: cantidad }], p.gastador.direccion, `${p.id}-q-${variante.id}-${Date.now()}`);
  } catch (e) {
    if (e instanceof ReapError) throw new ErrorPermiso('reap', `Reap no pudo cotizar: ${e.code} ${e.message}`, 502);
    throw e;
  }
  // Reap preselecciona un envío que no siempre es el más barato: para quien paga, se elige el más barato antes de evaluar.
  const barata = [...q.shippingOptions].sort((a, b) => a.price.amount - b.price.amount)[0];
  if (barata && !barata.selected) {
    try { q = await reap.selectShipping(q.id, barata.id); } catch (e) { evento(p.id, 'envio_no_cambiado', { error: String(e) }); }
  }
  return guardarCotizacion(p, q, { prod, variante, dominio, cantidad });
}

function guardarCotizacion(p: Permiso, q: Quote, x: { prod: any; variante: any; dominio: string; cantidad: number }) {
  const total = q.amountBreakdown.finalAmount.amount;
  const moneda = q.amountBreakdown.finalAmount.currency;
  const aprobada = db.prepare(`SELECT monto FROM excepciones WHERE permiso_id = ? AND variant_id = ? AND estado = 'aprobada' ORDER BY resuelto DESC LIMIT 1`).get(p.id, x.variante.id) as any;
  const v = evaluar(p, gastado(p.id), {
    total, moneda, tienda: x.dominio, categoria: porDominio.get(x.dominio)?.categoria ?? null, cantidad: x.cantidad,
    aprobada: !!aprobada, montoAprobado: aprobada?.monto,
  });
  const producto = { id: x.prod.id, nombre: x.prod.name, variante: x.variante.name ?? null, tienda: x.dominio, tiendaNombre: x.prod.merchant?.name, imagen: x.prod.media?.[0]?.url ?? null, cantidad: x.cantidad };
  db.prepare(`INSERT OR REPLACE INTO cotizaciones (id, permiso_id, variant_id, producto, tienda, total, moneda, desglose, veredicto, vence, creado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(q.id, p.id, x.variante.id, JSON.stringify(producto), x.dominio, total, moneda,
    JSON.stringify(q.amountBreakdown), JSON.stringify(v), q.expiresAt, ahora());
  evento(p.id, 'cotizacion', { cotizacion: q.id, producto: producto.nombre, total, veredicto: v.tipo });
  return {
    cotizacionId: q.id,
    producto,
    desglose: {
      articulos: q.amountBreakdown.itemsSubtotal.amount,
      envio: q.amountBreakdown.shipping?.amount ?? 0,
      impuestos: q.amountBreakdown.tax?.amount?.amount ?? 0,
      total,
      moneda,
    },
    veredicto: v,
    vence: q.expiresAt,
    siguiente: siguientePaso(v),
  };
}

function siguientePaso(v: Veredicto) {
  if (v.tipo === 'ok') return 'Dentro de las reglas: se puede comprar con comprar(cotizacionId).';
  if (v.tipo === 'requiere_aprobacion') return `Pasa del saldo por ${v.diferencia}. comprar(cotizacionId) le pide aprobación al financiador; también puedes elegir otra opción.`;
  return `Fuera de reglas: ${v.razones.join('; ')}. Elige otra opción.`;
}

// ---------- comprar ----------

export async function comprar(p: Permiso, cotizacionId: string): Promise<any> {
  vivo(p);
  const c = db.prepare('SELECT * FROM cotizaciones WHERE id = ? AND permiso_id = ?').get(cotizacionId, p.id) as any;
  if (!c) throw new ErrorPermiso('cotizacion', 'esa cotización no es de este permiso', 404);
  const abierta = db.prepare(`SELECT id FROM compras WHERE permiso_id = ? AND estado IN ('REQUIRES_ACTION', 'PROCESSING')`).get(p.id) as any;
  if (abierta) await estadoCompra(p, abierta.id);
  const sigueAbierta = db.prepare(`SELECT id, url FROM compras WHERE permiso_id = ? AND estado IN ('REQUIRES_ACTION', 'PROCESSING')`).get(p.id) as any;
  if (sigueAbierta) throw new ErrorPermiso('compra_abierta', `ya hay una compra esperando aprobación: ${sigueAbierta.url}`, 409);

  // Re-evalúa con lo gastado de ahora y la aprobación vigente.
  const producto = J(c.producto);
  let quoteId = c.id as string;
  let total = c.total as number;
  if (new Date(c.vence).getTime() < Date.now() + 60_000) {
    // La cotización venció: se cotiza de nuevo el mismo artículo y se vuelve a evaluar.
    const nueva = await cotizarInterno(p, { productId: producto.id, variantId: c.variant_id, cantidad: producto.cantidad, tienda: c.tienda });
    quoteId = nueva.cotizacionId;
    total = nueva.desglose.total;
    evento(p.id, 'recotizada', { antes: c.id, despues: quoteId, total });
  }
  const aprobada = db.prepare(`SELECT monto FROM excepciones WHERE permiso_id = ? AND variant_id = ? AND estado = 'aprobada' ORDER BY resuelto DESC LIMIT 1`).get(p.id, c.variant_id) as any;
  const v = evaluar(p, gastado(p.id), {
    total, moneda: c.moneda, tienda: c.tienda, categoria: porDominio.get(c.tienda)?.categoria ?? null, cantidad: producto.cantidad,
    aprobada: !!aprobada, montoAprobado: aprobada?.monto,
  });

  if (v.tipo === 'fuera_de_reglas') {
    evento(p.id, 'bloqueada', { cotizacion: quoteId, razones: v.razones });
    return { estado: 'bloqueada', razones: v.razones, saldo: v.saldo };
  }
  if (v.tipo === 'requiere_aprobacion') {
    const ya = db.prepare(`SELECT * FROM excepciones WHERE permiso_id = ? AND variant_id = ? AND estado = 'pendiente'`).get(p.id, c.variant_id) as any;
    const exId = ya?.id ?? id('ex', 4);
    if (!ya) {
      db.prepare(`INSERT INTO excepciones (id, permiso_id, cotizacion_id, variant_id, motivo, monto, creado) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(exId, p.id, quoteId, c.variant_id, `${producto.nombre}: ${v.razones.join('; ')}`, total, ahora());
      evento(p.id, 'excepcion', { excepcion: exId, monto: total, diferencia: v.diferencia });
      // El financiador decide por política (Jev, tipado) sin bloquear la respuesta; sólo lo dudoso llega a una persona.
      decidirEnSegundoPlano(p, exId, { saldo: v.saldo, total, diferencia: v.diferencia, producto: producto.nombre, tienda: c.tienda });
    }
    return { estado: 'esperando_aprobacion', excepcionId: exId, diferencia: v.diferencia, mensaje: 'Se le pidió a quien paga. En cuanto decida, la compra sigue sola.' };
  }

  return abrirCheckout(p, quoteId, total, c.moneda);
}

async function abrirCheckout(p: Permiso, quoteId: string, total: number, moneda: string) {
  // Track 2: el contrato libera el monto cuando el cargo se completa (ver estadoCompra), no al abrir el pago,
  // para que un checkout que nadie aprueba no mueva USDC.
  const tx: string | null = null;
  const insc = await reap.getEnrollment(p.gastador.enrollmentId);
  if (insc.status !== 'ACTIVE') throw new ErrorPermiso('tarjeta', 'La tarjeta guardada ya no está activa. Hay que volver a registrarla antes de comprar.', 409);
  const ch = await reap.createCheckout(quoteId, p.gastador.enrollmentId, `${config.publicUrl}/retorno?p=${p.id}&f=${firmaRetorno(p.id)}`, { key: `${p.id}-co-${quoteId}`, simulate: 'COMPLETED' });
  const monto = ch.amount?.amount ?? total;
  db.prepare(`INSERT OR REPLACE INTO compras (id, permiso_id, cotizacion_id, estado, monto, moneda, orden, url, tx, creado, actualizado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ch.id, p.id, quoteId, ch.status, monto, ch.amount?.currency ?? moneda, ch.orderId ?? null, ch.nextAction?.url ?? null, tx, ahora(), ahora());
  evento(p.id, 'checkout', { compra: ch.id, monto, estado: ch.status, tx });
  vigilar(p, ch.id);
  // Quien paga autoriza: el enlace de Reap le llega al número del financiador. Cada compra trae su propio enlace,
  // así varias compras pueden esperar aprobación a la vez sin que una detenga a la otra.
  if (ch.nextAction?.url) {
    const q = db.prepare('SELECT producto FROM cotizaciones WHERE id = ?').get(quoteId) as any;
    const prod = q ? J(q.producto).nombre : 'una compra';
    ganchos.avisarFinanciador(p, `[${p.financiador}] ${p.gastador.nombre} compra ${prod} por ${monto} ${moneda} (${p.titulo}). Aprueba el cargo aquí: ${ch.nextAction.url}`).catch(() => {});
  }
  return {
    estado: ch.status === 'COMPLETED' ? 'completada' : 'aprobar_en_reap',
    compraId: ch.id,
    monto,
    urlAprobacion: ch.nextAction?.url ?? null,
    mensaje: ch.nextAction?.url ? 'Abre el enlace en tu teléfono y aprueba con tu passkey. La tarjeta nunca pasa por nosotros.' : 'Compra completada.',
  };
}

export async function estadoCompra(p: Permiso, compraId: string) {
  const c = db.prepare('SELECT * FROM compras WHERE id = ? AND permiso_id = ?').get(compraId, p.id) as any;
  if (!c) throw new ErrorPermiso('compra', 'esa compra no es de este permiso', 404);
  if (['COMPLETED', 'FAILED', 'EXPIRED'].includes(c.estado)) return compraPublica(c);
  const ch = await reap.getCheckout(compraId);
  if (ch.status !== c.estado) {
    let recibo = null, hash = null, tx = null;
    if (ch.status === 'COMPLETED') {
      const q = db.prepare('SELECT producto FROM cotizaciones WHERE id = ?').get(c.cotizacion_id) as any;
      recibo = {
        permiso: p.id, compra: ch.id, orden: ch.orderId, producto: q ? J(q.producto) : null,
        monto: ch.finalAmount?.amount ?? c.monto, moneda: ch.finalAmount?.currency ?? c.moneda,
        financiador: p.financiador, gastador: p.gastador.nombre, fecha: ahora(),
      };
      hash = '0x' + createHash('sha256').update(JSON.stringify(recibo)).digest('hex');
      try {
        const txLib = await ganchos.onchainAutorizar(p, recibo.monto, c.cotizacion_id);
        if (txLib) evento(p.id, 'onchain_liberado', { compra: ch.id, monto: recibo.monto, tx: txLib });
        tx = await ganchos.onchainRecibo(p, ch.id, hash);
      } catch (e) { evento(p.id, 'onchain_error', { paso: 'liberar_recibo', error: String(e) }); }
    }
    db.prepare(`UPDATE compras SET estado = ?, orden = COALESCE(?, orden), monto = ?, recibo = COALESCE(?, recibo), recibo_hash = COALESCE(?, recibo_hash), tx = COALESCE(?, tx), actualizado = ? WHERE id = ?`)
      .run(ch.status, ch.orderId ?? null, ch.finalAmount?.amount ?? c.monto, recibo ? JSON.stringify(recibo) : null, hash, tx, ahora(), ch.id);
    evento(p.id, 'compra_estado', { compra: ch.id, estado: ch.status, orden: ch.orderId, hash, tx });
  }
  return compraPublica(db.prepare('SELECT * FROM compras WHERE id = ?').get(compraId));
}

export function estadoHumano(e: string) {
  return ({
    REQUIRES_ACTION: 'Esperando tu aprobación',
    PROCESSING: 'Pago aprobado, la tienda está confirmando el pedido',
    COMPLETED: 'Pedido confirmado',
    FAILED: 'No se completó, no se cobró',
    EXPIRED: 'Venció sin aprobarse',
  } as Record<string, string>)[e] ?? e;
}

function compraPublica(c: any) {
  return { compraId: c.id, estado: c.estado, estadoTexto: estadoHumano(c.estado), monto: c.monto, moneda: c.moneda, orden: c.orden, urlAprobacion: c.estado === 'REQUIRES_ACTION' ? c.url : null, reciboHash: c.recibo_hash, tx: c.tx };
}

// Sigue la compra hasta que termina y avisa a quien gasta (Reap no manda webhooks del módulo agéntico).
const vigiladas = new Set<string>();
function vigilar(p: Permiso, compraId: string) {
  if (vigiladas.has(compraId)) return;
  vigiladas.add(compraId);
  const hasta = Date.now() + 30 * 60_000;
  const t = setInterval(async () => {
    try {
      const c = await estadoCompra(obtener(p.id), compraId);
      if (c.estado === 'COMPLETED') {
        clearInterval(t); vigiladas.delete(compraId);
        await ganchos.avisarGastador(p, `Listo, compra completada: ${c.monto} ${c.moneda}, orden ${c.orden}. Te queda ${calcSaldo(p, gastado(p.id))} ${p.moneda}.`);
      } else if (['FAILED', 'EXPIRED'].includes(c.estado)) {
        clearInterval(t); vigiladas.delete(compraId);
        await ganchos.avisarGastador(p, c.estado === 'EXPIRED'
          ? 'El enlace para aprobar el pago venció y la compra no se hizo. Si quieres, la cotizo de nuevo.'
          : 'La compra no se completó (la tienda o el cobro no pasaron). No se te cobró. ¿La cotizo de nuevo o eliges otra?');
      } else if (Date.now() > hasta) {
        clearInterval(t); vigiladas.delete(compraId);
      }
    } catch { /* se reintenta en la próxima vuelta */ }
  }, 5000);
}

// Al arrancar, retoma la vigilancia de las compras abiertas (un reinicio no debe dejar a nadie sin aviso).
export function retomarVigilancia() {
  const abiertas = db.prepare(`SELECT id, permiso_id FROM compras WHERE estado IN ('REQUIRES_ACTION', 'PROCESSING')`).all() as any[];
  for (const c of abiertas) vigilar(obtener(c.permiso_id), c.id);
  return abiertas.length;
}

// El regreso de Reap lleva el id firmado; sin firma válida la página no muestra datos de la compra.
export function firmaRetorno(permisoId: string) {
  return createHmac('sha256', config.funderToken()).update('retorno:' + permisoId).digest('hex').slice(0, 24);
}

// Cuando la persona regresa de la página de aprobación de Reap se lee el checkout en ese momento.
export async function alRegresar(permisoId: string) {
  const abiertas = db.prepare(`SELECT id FROM compras WHERE permiso_id = ? AND estado IN ('REQUIRES_ACTION', 'PROCESSING')`).all(permisoId) as any[];
  const p = obtener(permisoId);
  const res = [];
  for (const c of abiertas) res.push(await estadoCompra(p, c.id));
  return res;
}

function decidirEnSegundoPlano(p: Permiso, exId: string, x: { saldo: number; total: number; diferencia: number; producto: string; tienda: string }) {
  (async () => {
    const politica: Politica = { ...POLITICA_BASE, ...((p.reglas as any).politica ?? {}) };
    const masBarata = db.prepare(`SELECT MIN(total) AS m FROM cotizaciones WHERE permiso_id = ?`).get(p.id) as any;
    let d;
    try {
      d = await decidirExcepcion(politica, {
        ...x, esLaMasBarata: masBarata?.m == null ? null : x.total <= masBarata.m + 0.01, categoriaPermitida: true,
        comprasPrevias: (db.prepare(`SELECT COUNT(*) AS n FROM compras WHERE permiso_id = ? AND estado = 'COMPLETED'`).get(p.id) as any).n,
        financiador: p.financiador,
      });
    } catch (e) { d = { decision: 'escalar' as const, razon: `El modelo de decisión falló: ${String(e).slice(0, 80)}`, confianza: 0, quien: 'politica' as const }; }
    evento(p.id, 'decision_politica', { excepcion: exId, ...d });
    const sigue = db.prepare('SELECT estado FROM excepciones WHERE id = ?').get(exId) as any;
    if (!sigue || sigue.estado !== 'pendiente') return;
    if (d.decision === 'aprobar') { await resolverExcepcion(exId, true, `Política: ${d.razon}`); return; }
    if (d.decision === 'rechazar') { await resolverExcepcion(exId, false, `Política: ${d.razon}`); return; }
    await ganchos.avisarFinanciador(p, `[${p.financiador}] ${p.gastador.nombre} quiere comprar ${x.producto} por ${x.total} ${p.moneda}; pasa del saldo (${x.saldo}) por ${x.diferencia}. ${d.razon}\nResponde "aprobar ${exId}" o "rechazar ${exId}".`);
    await ganchos.avisarGastador(p, 'Tu compra pasa del saldo y se le pidió a quien paga. Te aviso en cuanto decida.');
  })().catch(e => console.error('decidir', e));
}

// ---------- financiador ----------

export function excepcionesPendientes() {
  return db.prepare(`SELECT e.*, p.titulo, p.tope FROM excepciones e JOIN permisos p ON p.id = e.permiso_id WHERE e.estado = 'pendiente' AND e.permiso_id NOT IN (SELECT permiso_id FROM ocultos) ORDER BY e.creado`).all();
}

export async function resolverExcepcion(excepcionId: string, aprobar: boolean, nota?: string): Promise<any> {
  const e = db.prepare('SELECT * FROM excepciones WHERE id = ?').get(excepcionId) as any;
  if (!e) throw new ErrorPermiso('excepcion', `no existe la excepción ${excepcionId}`, 404);
  if (e.estado !== 'pendiente') throw new ErrorPermiso('excepcion', `la excepción ya está ${e.estado}`, 409);
  db.prepare('UPDATE excepciones SET estado = ?, nota = ?, resuelto = ? WHERE id = ?').run(aprobar ? 'aprobada' : 'rechazada', nota ?? null, ahora(), excepcionId);
  const p = obtener(e.permiso_id);
  evento(p.id, aprobar ? 'excepcion_aprobada' : 'excepcion_rechazada', { excepcion: excepcionId, monto: e.monto, nota });
  if (!aprobar) {
    await ganchos.avisarGastador(p, `El financiador no aprobó la compra (${e.motivo}).${nota ? ' Nota: ' + nota : ''} Puedes elegir otra opción dentro de tu saldo.`);
    return { excepcionId, estado: 'rechazada' };
  }
  // Aprobada: en la cadena el aprobador pone la diferencia; luego la compra sigue sola y al gastador le llega el enlace.
  const extra = r2(e.monto - calcSaldo(p, gastado(p.id)));
  if (extra > 0) {
    try {
      const tx = await ganchos.onchainAprobar(p, extra, e.cotizacion_id);
      if (tx) evento(p.id, 'onchain_aprobado', { excepcion: excepcionId, extra, tx });
    } catch (err) { evento(p.id, 'onchain_error', { paso: 'aprobar', error: String(err) }); }
  }
  try {
    const r = await comprar(p, e.cotizacion_id);
    if ('urlAprobacion' in r && r.urlAprobacion) {
      await ganchos.avisarGastador(p, `Aprobado. Confirma el cargo de ${r.monto} ${p.moneda} con tu passkey aquí: ${r.urlAprobacion}`);
    }
    return { excepcionId, estado: 'aprobada', compra: r };
  } catch (err) {
    return { excepcionId, estado: 'aprobada', compra: null, nota: `aprobada; la compra no se pudo abrir sola: ${String(err).slice(0, 200)}` };
  }
}

export async function cerrar(permisoId: string) {
  const p = obtener(permisoId);
  if (p.estado === 'cerrado') return resumen(p);
  const sobrante = calcSaldo(p, gastado(p.id));
  let tx: string | null = null;
  try { tx = await ganchos.onchainCerrar(p); } catch (e) { evento(p.id, 'onchain_error', { paso: 'cerrar', error: String(e) }); }
  db.prepare(`UPDATE permisos SET estado = 'cerrado', cerrado = ?, sobrante = ? WHERE id = ?`).run(ahora(), sobrante, p.id);
  if (tx) guardarOnchain(p.id, { txCierre: tx });
  evento(p.id, 'permiso_cerrado', { sobrante, tx });
  return resumen(obtener(p.id));
}

export function auditoria() {
  const permisos = listar().map(resumen);
  const eventos = db.prepare('SELECT * FROM eventos WHERE permiso_id IS NULL OR permiso_id NOT IN (SELECT permiso_id FROM ocultos) ORDER BY id DESC LIMIT 200').all().map((e: any) => ({ ...e, detalle: J(e.detalle) }));
  const compras = permisos.flatMap(p => p.compras);
  const completadas = compras.filter((c: any) => c.estado === 'COMPLETED');
  const tiempos = permisos.flatMap(p => p.compras.filter((c: any) => c.estado === 'COMPLETED').map((c: any) => (new Date(c.actualizado).getTime() - new Date(obtener(p.id).creado).getTime()) / 60000));
  const bloqueos = eventos.filter((e: any) => e.tipo === 'bloqueada').length;
  return {
    marcador: {
      permisos: permisos.length,
      compras: completadas.length,
      gastado: r2(completadas.reduce((s: number, c: any) => s + c.monto, 0)),
      sinIntervencion: (db.prepare(`SELECT COUNT(*) AS n FROM compras c JOIN cotizaciones q ON q.id = c.cotizacion_id WHERE c.estado = 'COMPLETED' AND json_extract(q.veredicto, '$.tipo') = 'ok' AND c.permiso_id NOT IN (SELECT permiso_id FROM ocultos)`).get() as any).n,
      excepciones: permisos.reduce((s, p) => s + p.excepciones.length, 0),
      bloqueos,
      sobranteDevuelto: r2(permisos.reduce((s, p) => s + (p.sobrante ?? 0), 0)),
      minutosMedianaPermisoACompra: tiempos.length ? r2(tiempos.sort((a, b) => a - b)[Math.floor(tiempos.length / 2)]) : null,
      conRecibo: completadas.filter((c: any) => c.recibo_hash).length,
    },
    permisos,
    eventos,
  };
}

// ---------- transacciones y línea de tiempo ----------

export function transacciones() {
  return (db.prepare(`SELECT c.*, p.titulo, p.plantilla, p.financiador, q.producto, q.tienda FROM compras c
    JOIN permisos p ON p.id = c.permiso_id LEFT JOIN cotizaciones q ON q.id = c.cotizacion_id WHERE c.permiso_id NOT IN (SELECT permiso_id FROM ocultos) ORDER BY c.creado DESC`).all() as any[])
    .map(c => ({
      compraId: c.id, permisoId: c.permiso_id, permiso: c.titulo, plantilla: c.plantilla, financiador: c.financiador,
      producto: c.producto ? J(c.producto).nombre : null, tienda: c.tienda, monto: c.monto, moneda: c.moneda,
      estado: c.estado, estadoTexto: estadoHumano(c.estado), orden: c.orden, reciboHash: c.recibo_hash, tx: c.tx, fecha: c.creado,
    }));
}

export function lineaDeTiempo(permisoId: string, compraId: string) {
  const c = db.prepare('SELECT * FROM compras WHERE id = ? AND permiso_id = ?').get(compraId, permisoId) as any;
  if (!c) throw new ErrorPermiso('compra', 'no existe esa compra', 404);
  const p = obtener(permisoId);
  const q = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(c.cotizacion_id) as any;
  const ex = db.prepare('SELECT * FROM excepciones WHERE permiso_id = ? AND variant_id = ? ORDER BY creado').all(permisoId, q?.variant_id ?? '') as any[];
  const ev = (db.prepare(`SELECT * FROM eventos WHERE permiso_id = ? ORDER BY id`).all(permisoId) as any[])
    .map(e => ({ ...e, detalle: J(e.detalle) }))
    .filter(e => [c.id, c.cotizacion_id].includes(e.detalle.compra) || e.detalle.cotizacion === c.cotizacion_id || ex.some(x => x.id === e.detalle.excepcion));
  const v = q ? J(q.veredicto) : null;
  const pasos: { ts: string; titulo: string; detalle: string; estado: 'hecho' | 'aviso' | 'falta' }[] = [];
  pasos.push({ ts: p.creado, titulo: `${p.financiador} apartó ${p.tope} ${p.moneda}`, detalle: `${p.titulo}. Reglas: ${p.reglas.categorias.join(', ')}, ${p.reglas.tiendas.length} tiendas, vence ${p.vence.slice(0, 10)}.`, estado: 'hecho' });
  if (q) pasos.push({ ts: q.creado, titulo: `Cotización: ${J(q.producto).nombre}`, detalle: `${q.tienda} · total ${q.total} ${q.moneda} con envío · reglas: ${v?.tipo === 'ok' ? 'dentro del saldo' : v?.tipo === 'requiere_aprobacion' ? `pasa del saldo por ${v.diferencia}` : (v?.razones ?? []).join('; ')}`, estado: v?.tipo === 'ok' ? 'hecho' : 'aviso' });
  for (const x of ex) {
    pasos.push({ ts: x.creado, titulo: 'Se pidió aprobación a quien paga', detalle: x.motivo, estado: 'aviso' });
    if (x.resuelto) pasos.push({ ts: x.resuelto, titulo: x.estado === 'aprobada' ? 'Quien paga aprobó' : 'Quien paga rechazó', detalle: x.nota ?? '', estado: x.estado === 'aprobada' ? 'hecho' : 'aviso' });
  }
  pasos.push({ ts: c.creado, titulo: 'Pago abierto en Reap', detalle: `${c.monto} ${c.moneda}. La persona aprueba con su passkey en la página de Reap; la tarjeta nunca pasa por Permiso.`, estado: 'hecho' });
  const aprobado = ['PROCESSING', 'COMPLETED'].includes(c.estado);
  pasos.push({ ts: c.actualizado, titulo: aprobado ? 'Pago aprobado por la persona' : c.estado === 'REQUIRES_ACTION' ? 'Esperando la aprobación de la persona' : estadoHumano(c.estado), detalle: aprobado ? 'Aprobado con passkey (Face ID).' : '', estado: aprobado ? 'hecho' : c.estado === 'REQUIRES_ACTION' ? 'falta' : 'aviso' });
  pasos.push({ ts: c.actualizado, titulo: c.estado === 'COMPLETED' ? `Pedido confirmado por la tienda${c.orden ? ' · orden ' + c.orden : ''}` : 'Pedido por confirmar en la tienda', detalle: c.estado === 'PROCESSING' ? 'Reap está colocando el pedido con la tienda.' : '', estado: c.estado === 'COMPLETED' ? 'hecho' : 'falta' });
  const lib = ev.find(e => e.tipo === 'onchain_liberado');
  if (p.onchain?.contrato) pasos.push({ ts: lib?.ts ?? c.actualizado, titulo: lib ? `El contrato liberó ${(lib.detalle.monto / 100).toFixed(4)} USDC a la bóveda Kwal` : 'USDC por liberar al confirmarse', detalle: lib ? `tx ${lib.detalle.tx}` : `Contrato ${p.onchain.contrato}`, estado: lib ? 'hecho' : 'falta' });
  if (c.recibo_hash) pasos.push({ ts: c.actualizado, titulo: 'Recibo guardado', detalle: `huella ${c.recibo_hash}${c.tx ? ' · en la cadena: ' + c.tx : ''}`, estado: 'hecho' });
  return { compra: { id: c.id, monto: c.monto, moneda: c.moneda, estado: c.estado, estadoTexto: estadoHumano(c.estado), orden: c.orden }, permiso: { id: p.id, titulo: p.titulo, financiador: p.financiador }, pasos };
}

// ---------- compra sin manos (Kwal): la bóveda del gastador paga, nadie toca el teléfono ----------
import * as kwal from './kwal.js';

function dominioDeComercio(nombre: string): string | null {
  const n = nombre.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const dom of porDominio.keys()) { if (dom.replace(/\..*$/, '').replace(/[^a-z0-9]/g, '') === n || dom.replace(/[^a-z0-9]/g, '').startsWith(n)) return dom; }
  return null;
}

export async function comprarSinManos(p: Permiso, consulta: string) {
  vivo(p);
  const k = (p.contexto as any)?.kwal;
  if (!k) throw new ErrorPermiso('kwal', 'Este permiso no paga desde la bóveda; usa comprar.', 403);
  const nombre = typeof k === 'string' ? k : undefined; // participante propio del distribuidor
  if (!kwal.kwalDisponible(nombre)) throw new ErrorPermiso('kwal', 'La bóveda de este distribuidor no está lista', 503);
  // Una compra a la vez por bóveda (Kwal sólo deja un pago por tarjeta); distribuidores distintos corren en paralelo.
  const llave = nombre ?? '_original';
  if (enCurso.has(llave)) throw new ErrorPermiso('en_curso', 'La bóveda de este distribuidor ya está pagando otra compra.', 409);
  enCurso.add(llave);
  try { return await kwal.con(nombre, () => comprarSinManosInterno(p, consulta)); } finally { enCurso.delete(llave); }
}

const enCurso = new Set<string>();

async function comprarSinManosInterno(p: Permiso, consulta: string) {
  const t0 = Date.now();
  const pasos: { paso: string; detalle: unknown }[] = [];
  const nota = (paso: string, detalle: unknown) => { pasos.push({ paso, detalle }); evento(p.id, 'sin_manos', { paso, detalle }); };
  // 1. Buscar en Kwal, quedarse con lo que la regla permite (tienda del catálogo, moneda) y cabe en el saldo.
  const s0 = calcSaldo(p, gastado(p.id));
  const prods = (await kwal.buscar(consulta, 10)).filter(x => x.moneda === p.moneda).map(x => ({ ...x, dominio: dominioDeComercio(x.merchant) }))
    .filter(x => x.dominio && p.reglas.tiendas.includes(x.dominio)).sort((a, b) => a.precio - b.precio);
  nota('busqueda', { consulta, candidatos: prods.slice(0, 5).map(x => [x.title.slice(0, 40), x.merchant, x.precio]) });
  if (!prods.length) return { estado: 'sin_opciones', pasos, mensaje: 'Nada en las tiendas permitidas para esa búsqueda.' };
  // 2. Cotizar el primero que tenga variante comprable y revisar las reglas con el total real.
  let elegido: any = null, q: any = null, v: any = null;
  for (const cand of prods.slice(0, 4)) {
    const vv = await kwal.variante(cand.productId); if (!vv) continue;
    const qq = await kwal.cotizar(vv.variantId, p.gastador.email, p.gastador.direccion).catch(e => { nota('cotizacion_fallida', { producto: cand.title, error: String(e).slice(0, 120) }); return null; });
    if (!qq) continue;
    const ver = evaluar(p, gastado(p.id), { total: qq.total, moneda: qq.moneda, tienda: cand.dominio!, categoria: porDominio.get(cand.dominio!)?.categoria ?? null, cantidad: 1 });
    nota('cotizacion', { producto: cand.title, tienda: cand.dominio, total: qq.total, veredicto: ver.tipo });
    if (ver.tipo === 'ok') { elegido = cand; q = qq; v = vv; break; }
  }
  if (!elegido) return { estado: 'bloqueada', pasos, mensaje: `Ninguna opción cabe en el saldo de ${s0} ${p.moneda} dentro de las reglas.` };
  // 2b. Apartar el monto antes de tocar la cadena o Kwal: una fila en compras que gastado() ya cuenta.
  const reservaId = `res_${q.quoteId}`;
  // node:sqlite no trae transaction(): BEGIN IMMEDIATE toma el candado de escritura y hace atómica la reserva.
  const reservado = (() => {
    db.exec('BEGIN IMMEDIATE');
    try {
    const ver = evaluar(obtener(p.id), gastado(p.id), { total: q.total, moneda: q.moneda, tienda: elegido.dominio, categoria: porDominio.get(elegido.dominio)?.categoria ?? null, cantidad: 1 });
    if (ver.tipo !== 'ok') { db.exec('ROLLBACK'); return false; }
    db.prepare(`INSERT OR REPLACE INTO cotizaciones (id, permiso_id, variant_id, producto, tienda, total, moneda, desglose, veredicto, vence, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(q.quoteId, p.id, v.variantId, JSON.stringify({ id: elegido.productId, nombre: elegido.title, variante: null, tienda: elegido.dominio, tiendaNombre: elegido.merchant, imagen: null, cantidad: 1, via: 'kwal' }), elegido.dominio, q.total, q.moneda,
        JSON.stringify({ itemsSubtotal: { amount: q.subtotal, currency: q.moneda }, shipping: { amount: q.envio, currency: q.moneda }, finalAmount: { amount: q.total, currency: q.moneda } }), JSON.stringify(ver), q.vence ?? ahora(), ahora());
    db.prepare(`INSERT INTO compras (id, permiso_id, cotizacion_id, estado, monto, moneda, creado, actualizado) VALUES (?, ?, ?, 'PROCESSING', ?, ?, ?, ?)`).run(reservaId, p.id, q.quoteId, q.total, q.moneda, ahora(), ahora());
    db.exec('COMMIT');
    return true;
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ya cerrada */ } throw e; }
  })();
  if (!reservado) return { estado: 'bloqueada', pasos, mensaje: 'El saldo cambió mientras se cotizaba; ya no cabe.' };
  const soltar = () => db.prepare(`UPDATE compras SET estado = 'FAILED', actualizado = ? WHERE id = ?`).run(ahora(), reservaId);
  // 3. El contrato libera exactamente el total a la bóveda; Kwal confirma que ya hay fondos.
  let txLib: string | null;
  try { txLib = await ganchos.onchainAutorizar(p, q.total, q.quoteId); } catch (e) { soltar(); throw e; }
  nota('contrato_libero', { usdc: q.total, tx: txLib });
  let f = await kwal.fondeo(q.quoteId);
  for (let i = 0; i < 18 && !f.estado.endsWith('READY'); i++) { await new Promise(r => setTimeout(r, 10_000)); f = await kwal.fondeo(q.quoteId); }
  nota('fondeo', f);
  if (!f.estado.endsWith('READY')) { if (!txLib) soltar(); return { estado: 'fondeo_pendiente', pasos, mensaje: `La bóveda aún no refleja los fondos (${f.estado}).${txLib ? ' El monto ya se liberó; se reintenta.' : ''}` }; }
  // 4. Pagar desde la bóveda. Sin passkey: la autorización fue la regla.
  let pg;
  try { pg = await kwal.pagar(q.quoteId); } catch (e) { if (!txLib) soltar(); throw e; }
  nota('pago_abierto', pg);
  db.prepare(`UPDATE compras SET id = ?, tx = ?, actualizado = ? WHERE id = ?`).run(pg.paymentId, txLib, ahora(), reservaId);
  let est = await kwal.pago(pg.paymentId);
  for (let i = 0; i < 18 && ['pending', 'processing', 'requires_action'].includes(est.estado); i++) { await new Promise(r => setTimeout(r, 10_000)); est = await kwal.pago(pg.paymentId); }
  nota('pago', est);
  const final = est.estado === 'completed' ? 'COMPLETED' : ['failed', 'declined', 'cancelled', 'expired'].includes(est.estado) ? 'FAILED' : 'PROCESSING';
  let hash: string | null = null, txRec: string | null = null;
  if (final === 'COMPLETED') {
    const recibo = { permiso: p.id, compra: pg.paymentId, orden: est.orden, producto: elegido.title, tienda: elegido.dominio, monto: q.total, moneda: q.moneda, financiador: p.financiador, gastador: p.gastador.nombre, via: 'kwal', fecha: ahora() };
    hash = '0x' + createHash('sha256').update(JSON.stringify(recibo)).digest('hex');
    try { txRec = await ganchos.onchainRecibo(p, pg.paymentId, hash); } catch (e) { evento(p.id, 'onchain_error', { paso: 'recibo', error: String(e) }); }
    db.prepare(`UPDATE compras SET estado = ?, orden = ?, recibo = ?, recibo_hash = ?, tx = COALESCE(?, tx), actualizado = ? WHERE id = ?`).run(final, est.orden, JSON.stringify(recibo), hash, txRec, ahora(), pg.paymentId);
  } else {
    db.prepare(`UPDATE compras SET estado = ?, actualizado = ? WHERE id = ?`).run(final, ahora(), pg.paymentId);
  }
  evento(p.id, 'compra_estado', { compra: pg.paymentId, estado: final, orden: est.orden, hash, tx: txRec, via: 'kwal' });
  return { estado: final === 'COMPLETED' ? 'completada' : final === 'FAILED' ? 'fallida' : 'procesando', compraId: pg.paymentId, producto: elegido.title, tienda: elegido.dominio, monto: q.total, moneda: q.moneda, orden: est.orden, txLiberacion: txLib, txRecibo: txRec, segundos: Math.round((Date.now() - t0) / 1000), pasos };
}

// Para enseñar un bloqueo explícito: cotiza de verdad un producto de una tienda que la regla no permite y devuelve
// el veredicto de las reglas (fuera_de_reglas con su motivo). No compra nada.
export async function probarTienda(p: Permiso, dominio: string, consulta = '') {
  vivo(p);
  if (!porDominio.get(dominio)) throw new ErrorPermiso('tienda', `${dominio} no está en la lista oficial de Reap`, 400);
  const r = await reap.search(consulta || porDominio.get(dominio)!.productoPrueba || dominio, { merchantName: dominio, mode: 'ONLY', limit: 1 });
  const prod = r.products?.[0];
  if (!prod) return { tienda: dominio, permitida: p.reglas.tiendas.includes(dominio), veredicto: null, nota: 'La tienda no devolvió productos para esa búsqueda.' };
  productoADominio.set(prod.id, dominio);
  const q = await cotizarInterno(p, { productId: prod.id, tienda: dominio });
  evento(p.id, 'prueba_tienda', { tienda: dominio, producto: q.producto.nombre, veredicto: q.veredicto.tipo });
  return { tienda: dominio, permitida: p.reglas.tiendas.includes(dominio), producto: q.producto.nombre, total: q.desglose.total, veredicto: q.veredicto, siguiente: q.siguiente };
}
