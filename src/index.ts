import express from 'express';
import { config } from './config.js';
import { api } from './api.js';
import { manejarMcp } from './mcp.js';
import { web } from './web.js';
import { manejarWhatsapp, manejarManual, responder } from './canal.js';
import { igual } from './api.js';
import * as servicio from './servicio.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { proveedor, consentimiento } from './oauth.js';
import { manejarMcpOAuth } from './mcp.js';
import { activar as activarOnchain } from './onchain.js';
import { vigilarIncidentes } from './incidentes.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás de cloudflared
app.use(express.json({ limit: '2mb' }));

app.get('/salud', (_req, res) => {
  res.json({ ok: true, servicio: 'permiso' });
});
app.get('/retorno', async (req, res) => {
  // Reap regresa aquí después de aprobar: se lee el checkout en ese momento (la guía de Reap lo pide).
  let texto = 'Ya puedes volver al chat. Permiso confirma la compra en unos segundos.';
  try {
    const pid = String(req.query.p ?? ''), f = String(req.query.f ?? '');
    const r = pid && f && igual(f, servicio.firmaRetorno(pid)) ? await servicio.alRegresar(pid) : [];
    if (r.length) texto = r.map((c: any) => `${c.estadoTexto} (${c.monto} ${c.moneda}${c.orden ? ', orden ' + c.orden : ''}).`).join(' ') + ' Te avisamos por el chat cuando cambie.';
  } catch { /* la página no falla por esto */ }
  const esc = (x: string) => x.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:2rem;max-width:520px;margin:auto"><h1>Listo</h1><p>${esc(texto)}</p></body>`);
});
// OAuth 2.1 para conectores MCP (Claude, ChatGPT): metadatos, registro, autorización con código de acceso, token.
app.use(mcpAuthRouter({
  provider: proveedor,
  issuerUrl: new URL(config.publicUrl),
  resourceServerUrl: new URL(`${config.publicUrl}/mcp`),
  scopesSupported: ['gastador', 'financiador'],
  resourceName: 'Permiso (sandbox)',
}));
app.use(consentimiento);
const conOAuth = requireBearerAuth({ verifier: proveedor, resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp` });
app.post('/mcp', conOAuth, (req, res) => { manejarMcpOAuth(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'mcp' }); }); });
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'usa POST' }));
// Modo replay: la página de aprobación local que en el sandbox real es la de Reap con passkey.
app.get('/replay/aprobar/:id', async (req, res) => {
  const { replay, aprobarReplay } = await import('./replay.js');
  if (!replay || !aprobarReplay(String(req.params.id))) return res.status(404).send('no encontrado');
  res.type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem"><h1>Cargo aprobado (replay)</h1><p>En el sandbox real esto es la página de Reap con passkey. Vuelve al chat: la compra se confirma en unos segundos.</p></body>');
});
app.use('/v1', api);
app.use(web);
// Landing pública (la escribe el agente de la página y el video en landing/).
app.use(express.static(new URL('../landing/', import.meta.url).pathname, { index: 'index.html', extensions: ['html'] }));
app.post('/canal/whatsapp', (req, res) => { manejarWhatsapp(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).end(); }); });
app.post('/canal/whatsapp/manual', manejarManual);
// Prueba del agente sin WhatsApp (sólo el financiador): {permisoId, texto, chat?}
app.post('/canal/prueba', async (req, res) => {
  if (!igual((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), config.funderToken())) return res.status(401).end();
  try { res.json({ respuesta: await responder(servicio.obtener(String(req.body.permisoId)), String(req.body.chat ?? 'prueba'), String(req.body.texto)) }); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});
app.post('/mcp/:token', (req, res) => { manejarMcp(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'mcp' }); }); });
app.get('/mcp/:token', (_req, res) => res.status(405).json({ error: 'usa POST (streamable HTTP sin sesión)' }));

console.log('onchain:', activarOnchain() ? 'activo' : 'apagado');
console.log('compras vigiladas:', servicio.retomarVigilancia());
vigilarIncidentes();
app.listen(config.port, '127.0.0.1', () => {
  console.log(`permiso escuchando en 127.0.0.1:${config.port}`);
});
