// Servidor MCP (streamable HTTP, sin sesión). La ruta lleva el enlace de capacidad: /mcp/<token>.
// Token del financiador: herramientas del financiador. Token de un permiso: herramientas de quien gasta.
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config.js';
import { igual } from './api.js';
import * as s from './servicio.js';
import { gastadorDemo } from './demo.js';

type Resultado = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function correr(f: () => Promise<unknown> | unknown): Promise<Resultado> {
  try {
    const r = await f();
    const obj = (r && typeof r === 'object' && !Array.isArray(r)) ? r as Record<string, unknown> : { resultado: r };
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 1) }], structuredContent: obj };
  } catch (e: any) {
    const msg = e instanceof s.ErrorPermiso ? e.message : String(e?.message ?? e);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}

const INSTRUCCIONES_GASTADOR = `Permiso: gastas dinero que otra parte (una aseguradora o una marca) apartó para ti, dentro de sus reglas.
Flujo: ver_permiso → buscar_opciones → cotizar → comprar → estado_compra.
- Las reglas las decide el servidor, no tú: si cotizar dice "fuera_de_reglas", no insistas; ofrece otra opción.
- "requiere_aprobacion" significa que cuesta más que el saldo: comprar se lo pide al financiador y la compra sigue sola si aprueba.
- comprar devuelve urlAprobacion: muéstrasela a la persona; ella aprueba el cargo con su passkey en la página de Reap. Nunca pidas datos de tarjeta.
- El precio de buscar_opciones no incluye envío; el total real sale de cotizar.
Responde en el idioma de la persona.`;

const INSTRUCCIONES_FINANCIADOR = `Permiso, vista de quien paga (aseguradora o marca): creas permisos fondeados para que otra persona compre dentro de tus reglas. Las excepciones las decide tu política sola; sólo ves las que se escalaron. Al crear un permiso, pásale a la persona el enlaceGastador o el mcpGastador que devuelve crear_permiso.
- crear_permiso: plantilla "reposicion" (siniestro aprobado, 7 días) o "mdf" (fondo de socio, 90 días).
- excepciones_pendientes y aprobar_excepcion / rechazar_excepcion: lo que se salió del saldo. Al aprobar, la compra sigue sola.
- auditoria: marcador, compras, recibos y lo que sobró.`;

function servidorGastador(token: string) {
  const srv = new McpServer({ name: 'permiso', version: '0.1.0' }, { instructions: INSTRUCCIONES_GASTADOR });
  const p = () => {
    const x = s.porToken(token);
    if (!x) throw new s.ErrorPermiso('token', 'el enlace ya no es válido', 401);
    return x;
  };
  srv.registerTool('ver_permiso', {
    title: 'Ver mi permiso',
    description: 'Qué te apartaron, cuánto queda, hasta cuándo, qué tiendas y categorías se permiten, y tus compras.',
    inputSchema: {},
  }, () => correr(() => s.resumen(p())));
  srv.registerTool('buscar_opciones', {
    title: 'Buscar opciones dentro de las reglas',
    description: 'Busca productos sólo en las tiendas permitidas que envían a tu dirección. Devuelve hasta 8, primero los que caben en el saldo.',
    inputSchema: { consulta: z.string().min(2).describe('qué buscas, en inglés funciona mejor, p. ej. "wireless headphones"'), tiendas: z.array(z.string()).optional().describe('limitar a ciertos dominios permitidos') },
  }, ({ consulta, tiendas }) => correr(() => s.opciones(p(), consulta, tiendas)));
  srv.registerTool('cotizar', {
    title: 'Cotizar con envío y revisar reglas',
    description: 'Pide a la tienda el total real (artículo + envío + impuestos) a tu dirección y devuelve el veredicto de las reglas: ok, requiere_aprobacion o fuera_de_reglas.',
    inputSchema: { productId: z.string().describe('productId de buscar_opciones'), cantidad: z.number().int().positive().optional() },
  }, ({ productId, cantidad }) => correr(() => s.cotizar(p(), { productId, cantidad })));
  srv.registerTool('comprar', {
    title: 'Comprar una cotización',
    description: 'Si la cotización está dentro de las reglas abre el pago y devuelve urlAprobacion para que la persona apruebe con su passkey. Si pasa del saldo, le pide aprobación al financiador. Si está fuera de reglas, la bloquea.',
    inputSchema: { cotizacionId: z.string() },
  }, ({ cotizacionId }) => correr(() => s.comprar(p(), cotizacionId)));
  srv.registerTool('comprar_sin_manos', {
    title: 'Comprar sin manos (la bóveda paga)',
    description: 'Para fondos que pagan desde la bóveda Kwal: busca en las tiendas permitidas, cotiza, el contrato libera el monto exacto y la bóveda paga. Nadie aprueba en un teléfono: la autorización fue la regla.',
    inputSchema: { consulta: z.string().min(2).describe('qué comprar, en inglés, p. ej. "keycaps"') },
  }, ({ consulta }) => correr(() => s.comprarSinManos(p(), consulta)));
  srv.registerTool('probar_tienda', {
    title: 'Probar una tienda fuera de la regla',
    description: 'Cotiza un producto real de cualquier tienda de la lista oficial de Reap y muestra qué dicen las reglas. Sirve para ver un bloqueo: si la tienda no está permitida, el veredicto es fuera_de_reglas con su motivo. No compra.',
    inputSchema: { tienda: z.string().describe('dominio de la lista oficial, p. ej. "deathwishcoffee.com"'), consulta: z.string().optional() },
  }, ({ tienda, consulta }) => correr(() => s.probarTienda(p(), tienda, consulta)));
  srv.registerTool('estado_compra', {
    title: 'Estado de una compra',
    description: 'Consulta si la compra ya se aprobó y se completó; al completarse trae número de orden y huella del recibo.',
    inputSchema: { compraId: z.string() },
  }, ({ compraId }) => correr(() => s.estadoCompra(p(), compraId)));
  return srv;
}

function servidorFinanciador() {
  const srv = new McpServer({ name: 'permiso-financiador', version: '0.1.0' }, { instructions: INSTRUCCIONES_FINANCIADOR });
  srv.registerTool('crear_permiso', {
    title: 'Crear un permiso fondeado',
    description: 'Aparta un monto con reglas para que otra persona compre. Devuelve el enlace y el MCP de quien gasta. Si no das datos del gastador, usa el cliente de demo (sandbox).',
    inputSchema: {
      plantilla: z.enum(['reposicion', 'mdf']),
      titulo: z.string().describe('p. ej. "Reposición de audífonos robados" o "Fondo Q4 de Distribuidora Norte"'),
      tope: z.number().positive().describe('monto en USD'),
      contexto: z.record(z.string(), z.unknown()).optional().describe('p. ej. {"siniestro":"CLM-002","articulo":"audífonos"} o {"socio":"Distribuidora Norte"}'),
      financiador: z.string().optional(),
    },
  }, ({ plantilla, titulo, tope, contexto, financiador }) => correr(async () => {
    const x = await s.crearPermiso({ plantilla, titulo, tope, contexto, financiador: financiador ?? 'Aseguradora Demo', gastador: gastadorDemo() });
    return { ...s.resumen(x), enlaceGastador: `${config.publicUrl}/p/${x.token}`, mcpGastador: `${config.publicUrl}/mcp/${x.token}` };
  }));
  srv.registerTool('listar_permisos', {
    title: 'Permisos', description: 'Todos los permisos con saldo, gastado, compras y excepciones.', inputSchema: {},
  }, () => correr(() => ({ permisos: s.listar().map(s.resumen) })));
  srv.registerTool('excepciones_pendientes', {
    title: 'Excepciones pendientes', description: 'Compras que pasaron del saldo y esperan tu decisión.', inputSchema: {},
  }, () => correr(() => ({ excepciones: s.excepcionesPendientes() })));
  srv.registerTool('aprobar_excepcion', {
    title: 'Aprobar una excepción', description: 'Aprueba la compra; sigue sola y a quien gasta le llega el enlace para confirmar el cargo.',
    inputSchema: { excepcionId: z.string(), nota: z.string().optional() },
  }, ({ excepcionId, nota }) => correr(() => s.resolverExcepcion(excepcionId, true, nota)));
  srv.registerTool('rechazar_excepcion', {
    title: 'Rechazar una excepción', description: 'Rechaza la compra; quien gasta puede elegir otra dentro de su saldo.',
    inputSchema: { excepcionId: z.string(), nota: z.string().optional() },
  }, ({ excepcionId, nota }) => correr(() => s.resolverExcepcion(excepcionId, false, nota)));
  srv.registerTool('cerrar_permiso', {
    title: 'Cerrar un permiso', description: 'Cierra el permiso y regresa lo que sobró al financiador.',
    inputSchema: { permisoId: z.string() },
  }, ({ permisoId }) => correr(() => s.cerrar(permisoId)));
  srv.registerTool('auditoria', {
    title: 'Auditoría', description: 'Marcador (compras, sin intervención, bloqueos, sobrante devuelto, tiempo), permisos y eventos.', inputSchema: {},
  }, () => correr(() => { const a = s.auditoria(); return { marcador: a.marcador, permisos: a.permisos, eventos: a.eventos.slice(0, 40) }; }));
  return srv;
}

export async function manejarMcp(req: Request, res: Response) {
  const token = String(req.params.token ?? '');
  let srv: McpServer;
  if (igual(token, config.funderToken())) srv = servidorFinanciador();
  else if (s.porToken(token)) srv = servidorGastador(token);
  else return res.status(404).json({ error: 'enlace no válido' });
  await atender(srv, req, res);
}

// Con OAuth: el rol y el permiso vienen del token verificado (req.auth).
export async function manejarMcpOAuth(req: Request, res: Response) {
  const extra = (req as any).auth?.extra ?? {};
  let srv: McpServer;
  if (extra.rol === 'financiador') srv = servidorFinanciador();
  else {
    const p = extra.permisoId ? s.obtener(String(extra.permisoId)) : null;
    if (!p) return res.status(403).json({ error: 'token sin permiso' });
    srv = servidorGastador(p.token);
  }
  await atender(srv, req, res);
}

async function atender(srv: McpServer, req: Request, res: Response) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); srv.close(); });
  await srv.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
