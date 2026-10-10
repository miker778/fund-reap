// Canal de WhatsApp: el puente (bridge/) entrega cada mensaje en POST /canal/whatsapp y contestamos por su
// POST /enviar. El agente es un bucle corto contra un LLM (cualquier API compatible con OpenAI), con las mismas herramientas del MCP.
import type { Request, Response } from 'express';
import { config } from './config.js';
import { db, ahora, evento } from './db.js';
import { igual } from './api.js';
import * as s from './servicio.js';

const chatsFinanciador = new Set<string>(); // chats (PN o LID) del número del financiador vistos por el puente
db.exec(`CREATE TABLE IF NOT EXISTS canal (chat TEXT PRIMARY KEY, permiso_id TEXT NOT NULL, actualizado TEXT NOT NULL)`);

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string };
const historial = new Map<string, Msg[]>();

const SISTEMA = (p: s.Permiso) => `Eres el asistente de Permiso por WhatsApp. ${p.financiador} apartó dinero para ${p.gastador.nombre} con reglas: "${p.titulo}"${p.contexto.siniestro ? ` (siniestro ${p.contexto.siniestro}, artículo: ${p.contexto.articulo ?? 'no dicho'})` : ''}.
Ayúdale a elegir y comprar dentro de esas reglas. Escribe como en WhatsApp: corto, claro, en español, sin markdown pesado, máximo 3 opciones a la vez con precio.
Reglas de oro:
- Las reglas las decide la herramienta cotizar/comprar, no tú. Si dice fuera_de_reglas, explícalo en una línea y ofrece otra opción.
- Si requiere_aprobacion, dile cuánto pasa del saldo y que comprar le pide aprobación al financiador; la compra sigue sola si aprueba.
- Cuando comprar devuelva urlAprobacion, mándale el enlace y dile que apruebe con su passkey (Face ID). Nunca pidas datos de tarjeta.
- El precio de buscar_opciones no incluye envío: cotiza antes de prometer un total.
- Nunca muestres códigos internos (PROCESSING, REQUIRES_ACTION, ids de cotización o compra). Usa estadoTexto de las herramientas; el número de orden sí se puede dar.
- Busca en inglés aunque te hablen en español (el catálogo está en inglés).
- En cada opción pon su enlace (campo enlace) en su propia línea para que la persona la vea en la tienda. La compra sólo se hace con comprar, nunca en la tienda directo.`;

const HERRAMIENTAS = [
  { name: 'ver_permiso', description: 'Saldo, tope, vencimiento, reglas y compras del permiso.', parameters: { type: 'object', properties: {} } },
  { name: 'buscar_opciones', description: 'Busca productos sólo en tiendas permitidas. Precio sin envío.', parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'en inglés' } }, required: ['consulta'] } },
  { name: 'cotizar', description: 'Total real con envío y veredicto de reglas (ok, requiere_aprobacion, fuera_de_reglas).', parameters: { type: 'object', properties: { productId: { type: 'string' } }, required: ['productId'] } },
  { name: 'comprar', description: 'Compra una cotización: abre el pago (devuelve urlAprobacion), pide aprobación o bloquea.', parameters: { type: 'object', properties: { cotizacionId: { type: 'string' } }, required: ['cotizacionId'] } },
  { name: 'estado_compra', description: 'Estado de una compra.', parameters: { type: 'object', properties: { compraId: { type: 'string' } }, required: ['compraId'] } },
].map(f => ({ type: 'function', function: f }));

async function ejecutar(p: s.Permiso, nombre: string, args: any) {
  switch (nombre) {
    case 'ver_permiso': return s.resumen(p);
    case 'buscar_opciones': return s.opciones(p, String(args.consulta ?? ''));
    case 'cotizar': return s.cotizar(p, { productId: String(args.productId) });
    case 'comprar': return s.comprar(p, String(args.cotizacionId));
    case 'estado_compra': return s.estadoCompra(p, String(args.compraId));
    default: throw new Error(`herramienta desconocida ${nombre}`);
  }
}

async function llm(messages: Msg[]) {
  const r = await fetch(`${config.llmUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.llmKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.llmModel, messages, tools: HERRAMIENTAS, temperature: 0.3 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return j.choices[0].message as Msg;
}

export async function responder(p: s.Permiso, chat: string, texto: string): Promise<string> {
  const h = historial.get(chat) ?? [];
  h.push({ role: 'user', content: texto });
  const mensajes: Msg[] = [{ role: 'system', content: SISTEMA(p) }, ...h.slice(-16)];
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const m = await llm(mensajes);
    const limpio: Msg = { role: 'assistant', content: m.content ?? '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
    mensajes.push(limpio);
    if (!m.tool_calls?.length) {
      h.push({ role: 'assistant', content: m.content ?? '' });
      historial.set(chat, h.slice(-20));
      return m.content ?? '';
    }
    for (const tc of m.tool_calls) {
      let salida: unknown;
      try { salida = await ejecutar(s.obtener(p.id), tc.function.name, JSON.parse(tc.function.arguments || '{}')); }
      catch (e: any) { salida = { error: e?.message ?? String(e) }; }
      evento(p.id, 'whatsapp_herramienta', { herramienta: tc.function.name });
      mensajes.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(salida).slice(0, 6000) });
    }
  }
  return 'Me tardé de más armando la respuesta. ¿Me lo repites en una línea?';
}

// ---------- puente ----------

async function puente(ruta: string, cuerpo: unknown) {
  if (!config.bridgeToken) return;
  await fetch(`${config.bridgeUrl}${ruta}`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(90_000), // el puente manda con pausas humanas; puede tardar
  }).catch(e => console.error('puente', ruta, e));
}

// Un chat sólo queda ligado a un permiso cuando quien gasta manda su enlace (lleva el token de capacidad).
// Sin enlace no hay permiso: nada de "el más reciente".
function permisoDelChat(chat: string, texto: string): { p: s.Permiso | null; recienLigado: boolean } {
  const m = texto.match(/\bt_[0-9a-f]{32}\b/);
  if (m) {
    const p = s.porToken(m[0]);
    if (p && p.estado === 'activo') { usarPermisoEnChat(chat, p.id); return { p, recienLigado: true }; }
  }
  const r = db.prepare('SELECT permiso_id FROM canal WHERE chat = ?').get(chat) as any;
  if (r) { try { const p = s.obtener(r.permiso_id); if (p.estado === 'activo') return { p, recienLigado: false }; } catch { /* borrado */ } }
  return { p: null, recienLigado: false };
}

export function usarPermisoEnChat(chat: string, permisoId: string) {
  db.prepare('INSERT OR REPLACE INTO canal (chat, permiso_id, actualizado) VALUES (?, ?, ?)').run(chat, permisoId, ahora());
  historial.delete(chat);
}

export async function manejarWhatsapp(req: Request, res: Response) {
  const tok = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!config.bridgeToken || !igual(tok, config.bridgeToken)) return res.status(401).json({ error: 'sin autorización' });
  const b = req.body ?? {};
  res.json({ ok: true }); // el puente espera 15 s como máximo: contestamos ya y trabajamos aparte
  const chat = String(b.chat ?? '');
  const texto = String(b.texto ?? '').trim();
  if (!chat) return;
  (async () => {
    if (!texto) { await puente('/enviar', { chat, texto: 'Por ahora sólo leo texto. ¿Me lo escribes?', cita: b.id }); return; }
    // El número del financiador: sólo decide excepciones.
    // El financiador se reconoce por su número (el puente lo manda), no por el formato del chat (puede llegar como LID).
    const fin = process.env.FUNDER_WHATSAPP;
    const dig = (x: string) => { const d = String(x ?? '').replace(/\D/g, ''); return d.startsWith('521') && d.length === 13 ? '52' + d.slice(3) : d; };
    // `numero` sólo llega del puente autenticado (bearer), que lo toma de la identidad del remitente en WhatsApp.
    const esGrupo = chat.endsWith('@g.us');
    const esFinanciador = !esGrupo && !!fin && (chat === fin || chatsFinanciador.has(chat) || (!!b.numero && dig(b.numero) === dig(fin.split('@')[0])));
    if (esFinanciador) chatsFinanciador.add(chat);
    if (esFinanciador) {
      const r = await respuestaDelFinanciador(texto);
      await puente('/enviar', { chat, texto: r ?? 'Soy Permiso. Aquí te llegan las excepciones de tus permisos; contesta "aprobar <id>" o "rechazar <id>".', cita: b.id });
      return;
    }
    const { p, recienLigado } = permisoDelChat(chat, texto);
    if (!p) { await puente('/enviar', { chat, texto: 'Hola. Para empezar mándame el enlace que te dio tu aseguradora (un enlace que termina en /p/…).', cita: b.id }); return; }
    if (recienLigado) {
      const r = s.resumen(p);
      await puente('/enviar', { chat, texto: `Listo, ${p.financiador} apartó ${r.saldo} ${r.moneda} para "${p.titulo}", vence el ${r.vence.slice(0, 10)}. ¿Qué necesitas reponer?`, cita: b.id });
      return;
    }
    await puente('/escribiendo', { chat });
    let respuesta: string;
    try { respuesta = await responder(p, chat, texto); }
    catch (e: any) { console.error(e); respuesta = 'Tuve un problema técnico. Intenta de nuevo en un momento.'; }
    await puente('/escribiendo', { chat, listo: true });
    await puente('/enviar', { chat, texto: respuesta, cita: b.id });
  })().catch(e => console.error('canal', e));
}

// El tomar-el-control de Sala llega aquí; en el demo no hace nada.
export function manejarManual(_req: Request, res: Response) {
  res.json({ ok: true });
}

// Avisos proactivos (aprobación del financiador, compra completada) al chat ligado al permiso.
s.ganchos.avisarGastador = async (p, texto) => {
  const r = db.prepare('SELECT chat FROM canal WHERE permiso_id = ?').get(p.id) as any;
  if (r?.chat) await puente('/enviar', { chat: r.chat, texto });
};

// Escalaciones al financiador: llegan a su WhatsApp (número del negocio) y se cierran con "aprobar <id>" o "rechazar <id>".
s.ganchos.avisarFinanciador = async (_p, texto) => {
  const chat = [...chatsFinanciador].pop() ?? process.env.FUNDER_WHATSAPP;
  if (chat) await puente('/enviar', { chat, texto });
};

export async function respuestaDelFinanciador(texto: string): Promise<string | null> {
  const m = texto.trim().match(/^(aprobar|rechazar)\s+(ex_[0-9a-f]+)\b(.*)$/i);
  if (!m) return null;
  try {
    const r = await s.resolverExcepcion(m[2], m[1].toLowerCase() === 'aprobar', m[3].trim() || undefined);
    return r.estado === 'aprobada' ? `Aprobada. La compra sigue sola${r.compra?.urlAprobacion ? ' y a la persona le llega el enlace para confirmar' : ''}.` : 'Rechazada. Se le avisó a la persona.';
  } catch (e: any) { return `No pude: ${e?.message ?? e}`; }
}
