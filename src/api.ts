// API REST. Financiador: Bearer FUNDER_TOKEN. Gastador: Bearer <token del permiso>.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import * as s from './servicio.js';
import { gastadorDemo } from './demo.js';
import { incidentes } from './incidentes.js';

export const api = Router();

const bearer = (req: Request) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
export function igual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function financiador(req: Request, res: Response, next: NextFunction) {
  if (!igual(bearer(req), config.funderToken())) return res.status(401).json({ error: 'token de financiador inválido' });
  next();
}
function gastador(req: Request, res: Response, next: NextFunction) {
  const p = s.porToken(bearer(req));
  if (!p) return res.status(401).json({ error: 'token de permiso inválido' });
  (req as any).permiso = p;
  next();
}

const envolver = (f: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
  try { res.json(await f(req)); }
  catch (e: any) {
    if (e instanceof s.ErrorPermiso) return res.status(e.http).json({ error: e.message, codigo: e.codigo });
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'datos inválidos', detalle: e.issues });
    console.error(e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
};

export const esquemaCrear = z.object({
  plantilla: z.enum(['reposicion', 'mdf']),
  titulo: z.string().min(3),
  financiador: z.string().min(2),
  tope: z.number().positive(),
  moneda: z.string().length(3).optional(),
  vence: z.string().optional(),
  contexto: z.record(z.string(), z.unknown()).optional(),
  tiendas: z.array(z.string()).optional(),
  categorias: z.array(z.string()).optional(),
  gastador: z.object({
    nombre: z.string(),
    email: z.string().email(),
    telefono: z.string().regex(/^\+\d{8,15}$/, 'E.164'),
    enrollmentId: z.string().optional(),
    direccion: z.object({
      firstName: z.string(), lastName: z.string(), phone: z.string(), addressLine1: z.string(), addressLine2: z.string().optional(),
      city: z.string(), region: z.string().optional(), postalCode: z.string().optional(), country: z.string().length(2),
    }),
  }),
});

// Financiador
api.post('/permisos', financiador, envolver(async req => {
  const p = await s.crearPermiso(esquemaCrear.parse(req.body));
  return { ...s.resumen(p), tokenGastador: p.token, enlaceGastador: `${config.publicUrl}/p/${p.token}`, mcpGastador: `${config.publicUrl}/mcp/${p.token}` };
}));
// Desde la consola: el gastador es el cliente de demo del sandbox.
api.post('/permisos/demo', financiador, envolver(async req => {
  const b = z.object({ plantilla: z.enum(['reposicion', 'mdf']), titulo: z.string().min(3), tope: z.number().positive(), financiador: z.string().default('Aseguradora Demo'), contexto: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
  const p = await s.crearPermiso({ ...b, gastador: gastadorDemo() });
  return { ...s.resumen(p), tokenGastador: p.token, enlaceGastador: `${config.publicUrl}/p/${p.token}`, mcpGastador: `${config.publicUrl}/mcp/${p.token}` };
}));
api.get('/permisos', financiador, envolver(() => s.listar().map(s.resumen)));
api.get('/permisos/:id', financiador, envolver(req => s.resumen(s.obtener(String(req.params.id)))));
api.post('/permisos/:id/cerrar', financiador, envolver(req => s.cerrar(String(req.params.id))));
api.get('/excepciones', financiador, envolver(() => s.excepcionesPendientes()));
api.post('/excepciones/:id/aprobar', financiador, envolver(req => s.resolverExcepcion(String(req.params.id), true, req.body?.nota)));
api.post('/excepciones/:id/rechazar', financiador, envolver(req => s.resolverExcepcion(String(req.params.id), false, req.body?.nota)));
api.get('/incidentes', financiador, envolver(() => incidentes()));
api.get('/transacciones', financiador, envolver(() => s.transacciones()));
api.get('/auditoria', financiador, envolver(() => s.auditoria()));

// Gastador
api.get('/yo', gastador, envolver(req => s.resumen((req as any).permiso)));
api.post('/yo/opciones', gastador, envolver(req => s.opciones((req as any).permiso, z.string().min(2).parse(req.body?.consulta), req.body?.tiendas)));
api.post('/yo/cotizar', gastador, envolver(req => s.cotizar((req as any).permiso, z.object({ productId: z.string(), cantidad: z.number().int().positive().optional() }).parse(req.body))));
api.post('/yo/comprar', gastador, envolver(req => s.comprar((req as any).permiso, z.string().parse(req.body?.cotizacionId))));
api.post('/yo/comprar-sin-manos', gastador, envolver(req => s.comprarSinManos((req as any).permiso, z.string().min(2).parse(req.body?.consulta))));
api.post('/yo/probar-tienda', gastador, envolver(req => s.probarTienda((req as any).permiso, z.string().parse(req.body?.tienda), req.body?.consulta)));
api.post('/demo/probar-tienda', financiador, envolver(req => s.probarTienda(s.obtener(z.string().parse(req.body?.permisoId)), z.string().parse(req.body?.tienda ?? 'deathwishcoffee.com'), req.body?.consulta)));
api.get('/yo/compras/:id', gastador, envolver(req => s.estadoCompra((req as any).permiso, String(req.params.id))));

// Escenarios de un clic (consola y demo) y el corredor de historia del demo.
import { ESCENARIOS } from './demo.js';
import { responder } from './canal.js';
import { randomBytes } from 'node:crypto';
api.post('/escenarios/:nombre', financiador, envolver(async req => {
  const e = (ESCENARIOS as any)[String(req.params.nombre)];
  if (!e) throw new s.ErrorPermiso('escenario', 'escenario desconocido', 404);
  const n = randomBytes(2).toString('hex').toUpperCase();
  const p = await s.crearPermiso({ plantilla: e.plantilla, titulo: e.titulo, financiador: e.financiador, tope: e.tope, contexto: e.contexto(n), gastador: gastadorDemo() });
  return { ...s.resumen(p), tokenGastador: p.token, enlaceGastador: `${config.publicUrl}/p/${p.token}`, mcpGastador: `${config.publicUrl}/mcp/${p.token}` };
}));
api.post('/demo/sin-manos', financiador, envolver(req => s.comprarSinManos(s.obtener(z.string().parse(req.body?.permisoId)), z.string().min(2).parse(req.body?.consulta ?? 'usb-c hub'))));
// El agente del cliente, manejado desde la página de demo (mismo agente que WhatsApp).
api.post('/demo/charla', financiador, envolver(async req => {
  const p = s.obtener(z.string().parse(req.body?.permisoId));
  const texto = z.string().min(1).parse(req.body?.texto);
  return { respuesta: await responder(p, `demo:${p.id}`, texto) };
}));

// ---------- marca: cartera de distribuidores, compras sin manos en paralelo, cierre de trimestre ----------
import { DISTRIBUIDORES, gastadorDistribuidor, carteraSimulada } from './demo.js';

const esMarca = (p: s.Permiso) => p.plantilla === 'mdf' && typeof (p.contexto as any)?.kwal === 'string' && p.estado === 'activo';

api.post('/marca/lanzar', financiador, envolver(async req => {
  const tope = Number(req.body?.tope ?? 10);
  const ya = new Set(s.listar().filter(esMarca).map(p => (p.contexto as any).kwal));
  const creados = [];
  for (const d of DISTRIBUIDORES) {
    if (ya.has(d.kwal)) continue;
    const p = await s.crearPermiso({ plantilla: 'mdf', titulo: `Fondo co-op Q4 · ${d.socio}`, financiador: 'Marca Demo', tope, contexto: { socio: d.socio, kwal: d.kwal, trimestre: 'Q4' }, gastador: gastadorDistribuidor(d) });
    creados.push({ id: p.id, socio: d.socio, onchain: p.onchain?.txCreacion ?? null });
  }
  return { creados };
}));

// Cada distribuidor compra con su propia bóveda, todos a la vez: nadie espera a nadie.
api.post('/marca/correr', financiador, envolver(async req => {
  const consulta = String(req.body?.consulta ?? 'keycaps');
  const ps = s.listar().filter(esMarca);
  const t0 = Date.now();
  const resultados = await Promise.all(ps.map(p => s.comprarSinManos(p, consulta).then(r => ({ socio: (p.contexto as any).socio, ...r, pasos: undefined })).catch(e => ({ socio: (p.contexto as any).socio, estado: 'error', mensaje: String(e?.message ?? e) }))));
  return { segundos: Math.round((Date.now() - t0) / 1000), resultados };
}));

api.post('/marca/cerrar-trimestre', financiador, envolver(async () => {
  const ps = s.listar().filter(esMarca);
  const out = [];
  for (const p of ps) { const r = await s.cerrar(p.id); out.push({ socio: (p.contexto as any).socio, sobrante: r.sobrante, tx: (r.onchain as any)?.txCierre ?? null }); }
  return { cerrados: out };
}));

api.get('/marca/panel', financiador, envolver(() => {
  const reales = s.listar().filter(p => p.plantilla === 'mdf' && typeof (p.contexto as any)?.kwal === 'string').map(p => {
    const r = s.resumen(p);
    const dec = s.auditoria().eventos.filter((e: any) => e.permiso_id === p.id);
    return { id: p.id, socio: (p.contexto as any).socio, ciudad: p.gastador.direccion.city, tope: r.tope, gastado: r.gastado, saldo: r.saldo, estado: r.estado, sobrante: r.sobrante,
      compras: r.compras.filter((c: any) => c.estado === 'COMPLETED').length, excepciones: r.excepciones.length, bloqueos: dec.filter((e: any) => e.tipo === 'bloqueada').length,
      boveda: (p.onchain as any)?.bovedaKwal ?? null, txCreacion: (p.onchain as any)?.txCreacion ?? null, txCierre: (p.onchain as any)?.txCierre ?? null,
      ultimas: r.compras.slice(-3).reverse().map((c: any) => ({ producto: c.recibo?.producto ?? null, monto: c.monto, estado: c.estadoTexto, orden: c.orden, tx: c.tx, id: c.id })) };
  });
  const sim = carteraSimulada();
  const todos = [...reales, ...sim];
  const tot = (k: string) => todos.reduce((a: number, x: any) => a + (x[k] ?? 0), 0);
  const asignado = tot('tope'), gastado = tot('gastado');
  return {
    kpis: { distribuidores: todos.length, reales: reales.length, asignado, gastado, utilizacion: asignado ? Math.round(100 * gastado / asignado) : 0,
      compras: tot('compras'), excepciones: tot('excepciones'), sinPersona: Math.round(100 * (1 - (tot('excepciones') - tot('autoAprobadas')) / Math.max(1, tot('compras')))), bloqueos: tot('bloqueos') },
    reales, simulados: sim,
  };
}));
