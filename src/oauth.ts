// OAuth 2.1 para el MCP (Claude, ChatGPT y otros conectores). Sólo para probar en el sandbox:
// - registro dinámico de clientes, pero sólo con redirect a hosts conocidos (claude, chatgpt, grok, localhost);
// - la página de autorización pide el código de acceso que damos en la entrega: sin código no hay token;
// - "cliente" crea un siniestro de prueba propio para quien prueba; "aseguradora" da la vista del financiador;
// - PKCE obligatorio, tokens de 24 h (refresh 3 días), guardados como hash, revocables.
import type { Request, Response, Router } from 'express';
import express from 'express';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { db, ahora, evento } from './db.js';
import { config } from './config.js';
import { igual } from './api.js';
import * as s from './servicio.js';
import { gastadorDemo } from './demo.js';

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clientes (id TEXT PRIMARY KEY, datos TEXT NOT NULL, creado TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codigos (codigo TEXT PRIMARY KEY, cliente TEXT NOT NULL, reto TEXT NOT NULL, redirect TEXT NOT NULL,
  rol TEXT NOT NULL, permiso_id TEXT, vence INTEGER NOT NULL, usado INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, tipo TEXT NOT NULL, cliente TEXT NOT NULL, rol TEXT NOT NULL,
  permiso_id TEXT, vence INTEGER NOT NULL, revocado INTEGER NOT NULL DEFAULT 0, creado TEXT NOT NULL);
`);

const HOSTS_PERMITIDOS = ['claude.ai', 'claude.com', 'chatgpt.com', 'chat.openai.com', 'openai.com', 'grok.com', 'x.ai', 'localhost', '127.0.0.1'];
const hostOk = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return HOSTS_PERMITIDOS.some(p => h === p || h.endsWith('.' + p));
  } catch { return false; }
};
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
const ACCESO_H = 24 * 3600, REFRESH_H = 72 * 3600;

const clientes: OAuthRegisteredClientsStore = {
  getClient(id) {
    const r = db.prepare('SELECT datos FROM oauth_clientes WHERE id = ?').get(id) as any;
    return r ? JSON.parse(r.datos) : undefined;
  },
  registerClient(c) {
    const uris: string[] = (c as any).redirect_uris ?? [];
    if (!uris.length || !uris.every(hostOk)) throw new InvalidClientMetadataError('redirect_uri no permitido para este sandbox');
    const full = { ...c, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
    db.prepare('INSERT INTO oauth_clientes (id, datos, creado) VALUES (?, ?, ?)').run(full.client_id, JSON.stringify(full), ahora());
    evento(null, 'oauth_cliente', { cliente: full.client_id, nombre: (full as any).client_name ?? null, redirect: uris });
    return full;
  },
};

function emitir(cliente: string, rol: string, permisoId: string | null): OAuthTokens {
  const acceso = 'pa_' + randomBytes(24).toString('hex');
  const refresh = 'pr_' + randomBytes(24).toString('hex');
  const ins = db.prepare('INSERT INTO oauth_tokens (hash, tipo, cliente, rol, permiso_id, vence, creado) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const t = Math.floor(Date.now() / 1000);
  ins.run(sha(acceso), 'acceso', cliente, rol, permisoId, t + ACCESO_H, ahora());
  ins.run(sha(refresh), 'refresh', cliente, rol, permisoId, t + REFRESH_H, ahora());
  return { access_token: acceso, token_type: 'bearer', expires_in: ACCESO_H, refresh_token: refresh, scope: rol };
}

export const proveedor: OAuthServerProvider = {
  get clientsStore() { return clientes; },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    // La página de consentimiento: nada se emite hasta que la persona mete el código de acceso.
    const campos = { client_id: client.client_id, redirect_uri: params.redirectUri, state: params.state ?? '', code_challenge: params.codeChallenge };
    const ocultos = Object.entries(campos).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
    res.type('html').send(paginaConsentimiento((client as any).client_name ?? 'un asistente', ocultos, ''));
  },

  async challengeForAuthorizationCode(_client, codigo) {
    const r = db.prepare('SELECT reto FROM oauth_codigos WHERE codigo = ?').get(sha(codigo)) as any;
    if (!r) throw new InvalidGrantError('código inválido');
    return r.reto;
  },

  async exchangeAuthorizationCode(client, codigo, _verifier, redirectUri) {
    const r = db.prepare('SELECT * FROM oauth_codigos WHERE codigo = ?').get(sha(codigo)) as any;
    if (!r || r.usado || r.cliente !== client.client_id || r.vence < Date.now()) throw new InvalidGrantError('código inválido o vencido');
    if (redirectUri && redirectUri !== r.redirect) throw new InvalidGrantError('redirect_uri no coincide');
    db.prepare('UPDATE oauth_codigos SET usado = 1 WHERE codigo = ?').run(sha(codigo));
    evento(r.permiso_id, 'oauth_token', { cliente: client.client_id, rol: r.rol });
    return emitir(client.client_id, r.rol, r.permiso_id);
  },

  async exchangeRefreshToken(client, refresh) {
    const r = db.prepare(`SELECT * FROM oauth_tokens WHERE hash = ? AND tipo = 'refresh'`).get(sha(refresh)) as any;
    if (!r || r.revocado || r.cliente !== client.client_id || r.vence < Date.now() / 1000) throw new InvalidGrantError('refresh inválido');
    db.prepare('UPDATE oauth_tokens SET revocado = 1 WHERE hash = ?').run(sha(refresh));
    return emitir(client.client_id, r.rol, r.permiso_id);
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = db.prepare(`SELECT * FROM oauth_tokens WHERE hash = ? AND tipo = 'acceso'`).get(sha(token)) as any;
    if (!r || r.revocado || r.vence < Date.now() / 1000) throw new InvalidTokenError('token inválido');
    return { token, clientId: r.cliente, scopes: [r.rol], expiresAt: r.vence, extra: { rol: r.rol, permisoId: r.permiso_id } };
  },

  async revokeToken(_client, req: OAuthTokenRevocationRequest) {
    db.prepare('UPDATE oauth_tokens SET revocado = 1 WHERE hash = ?').run(sha(req.token));
  },
};

// ---------- consentimiento ----------

const intentos = new Map<string, { n: number; desde: number }>();
function limitar(ip: string) {
  const x = intentos.get(ip);
  if (!x || Date.now() - x.desde > 10 * 60_000) { intentos.set(ip, { n: 1, desde: Date.now() }); return true; }
  x.n++;
  return x.n <= 10;
}

export const consentimiento: Router = express.Router();
consentimiento.post('/oauth/consentir', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const client = await clientes.getClient(String(b.client_id ?? ''));
  const redirect = String(b.redirect_uri ?? '');
  if (!client || !(client as any).redirect_uris?.includes(redirect)) return res.status(400).send('cliente o redirect inválido');
  const ocultos = ['client_id', 'redirect_uri', 'state', 'code_challenge'].map(k => `<input type="hidden" name="${k}" value="${esc(b[k] ?? '')}">`).join('');
  const reintentar = (msg: string) => res.status(401).type('html').send(paginaConsentimiento((client as any).client_name ?? 'un asistente', ocultos, msg));
  if (!limitar(req.ip ?? 'x')) return reintentar('Demasiados intentos. Espera unos minutos.');
  const codigoAcceso = config.accessCode();
  if (!codigoAcceso || !igual(String(b.acceso ?? '').trim(), codigoAcceso)) {
    evento(null, 'oauth_rechazado', { cliente: client.client_id });
    return reintentar('Ese código de acceso no es válido.');
  }
  // Cuatro puertas: aseguradora y marca (financiador), cliente y distribuidor (gastador con su propio permiso de prueba).
  const puerta = ['aseguradora', 'cliente', 'marca', 'distribuidor'].includes(String(b.rol)) ? String(b.rol) : 'cliente';
  const rol = puerta === 'aseguradora' || puerta === 'marca' ? 'financiador' : 'gastador';
  let permisoId: string | null = null;
  if (puerta === 'cliente') {
    const p = await s.crearPermiso({
      plantilla: 'reposicion', titulo: 'Reposición de audífonos (prueba)', financiador: 'Aseguradora Demo', tope: 120,
      contexto: { siniestro: 'CLM-' + randomBytes(2).toString('hex').toUpperCase(), articulo: 'Audífonos inalámbricos', via: (client as any).client_name ?? 'conector' },
      gastador: gastadorDemo(),
    });
    permisoId = p.id;
  } else if (puerta === 'distribuidor') {
    // Entra a uno de los distribuidores en vivo (bóveda Kwal propia, fondo bloqueado en el contrato), el de más saldo.
    const vivos = s.listar().filter(x => x.plantilla === 'mdf' && typeof (x.contexto as any)?.kwal === 'string' && x.estado === 'activo')
      .map(x => ({ x, saldo: s.resumen(x).saldo })).sort((a, b) => b.saldo - a.saldo);
    if (vivos.length) { permisoId = vivos[0].x.id; }
    else {
    const p = await s.crearPermiso({
      plantilla: 'mdf', titulo: 'Fondo co-op Q4 (prueba)', financiador: 'Marca Demo', tope: 150,
      contexto: { socio: 'Distribuidor ' + randomBytes(2).toString('hex').toUpperCase(), via: (client as any).client_name ?? 'conector' },
      gastador: gastadorDemo(),
    });
    permisoId = p.id;
    }
  }
  const codigo = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO oauth_codigos (codigo, cliente, reto, redirect, rol, permiso_id, vence) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha(codigo), client.client_id, String(b.code_challenge ?? ''), redirect, rol, permisoId, Date.now() + 5 * 60_000);
  const u = new URL(redirect);
  u.searchParams.set('code', codigo);
  if (b.state) u.searchParams.set('state', String(b.state));
  res.redirect(302, u.toString());
});

function esc(x: unknown) { return String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

function paginaConsentimiento(cliente: string, ocultos: string, error: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar a Permiso</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#14161a;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:1.5rem;max-width:420px;width:92%}h1{font-size:20px;margin:0 0 .3rem}
.m{color:#5b6170;font-size:13px}label{display:block;margin:.8rem 0 .3rem;font-size:13px;color:#5b6170}input[type=text]{width:100%;padding:.5rem;border:1px solid #e4e6eb;border-radius:8px;font:inherit}
.r{display:flex;gap:.5rem;align-items:flex-start;margin:.4rem 0}button{margin-top:1rem;width:100%;padding:.6rem;border:0;border-radius:8px;background:#14161a;color:#fff;font:inherit;cursor:pointer}
.e{background:#fde7e5;color:#b42318;padding:.5rem .7rem;border-radius:8px;font-size:13px;margin-top:.6rem}</style></head><body>
<form method="post" action="/oauth/consentir">${ocultos}
<h1>Conectar ${esc(cliente)} a Permiso</h1><div class="m">Sandbox del hackathon Reap x AIBM. No se mueve dinero real.</div>
${error ? `<div class="e">${esc(error)}</div>` : ''}
<label>Código de acceso (viene en la entrega del proyecto)</label><input type="text" name="acceso" autocomplete="off" required>
<label>¿Cómo quieres entrar?</label>
<div class="r"><input type="radio" name="rol" value="cliente" id="r1" checked><label for="r1" style="margin:0;color:inherit"><b>Cliente de una aseguradora.</b> Recibes un siniestro de prueba con 120 USD para reponer unos audífonos.</label></div>
<div class="r"><input type="radio" name="rol" value="aseguradora" id="r2"><label for="r2" style="margin:0;color:inherit"><b>Aseguradora.</b> Creas permisos, ves transacciones y decides excepciones.</label></div>
<div class="r"><input type="radio" name="rol" value="distribuidor" id="r3"><label for="r3" style="margin:0;color:inherit"><b>Distribuidor de una marca.</b> Entras a un fondo co-op en vivo, bloqueado en el contrato, que paga desde su propia bóveda Kwal sin aprobación en el teléfono.</label></div>
<div class="r"><input type="radio" name="rol" value="marca" id="r4"><label for="r4" style="margin:0;color:inherit"><b>Marca.</b> Creas fondos por distribuidor y ves lo que compran.</label></div>
<button>Autorizar</button><div class="m" style="margin-top:.6rem">El acceso dura 24 horas y se puede revocar.</div></form></body></html>`;
}
