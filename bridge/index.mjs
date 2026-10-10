// Permiso WhatsApp bridge. Holds one WhatsApp session (Baileys, paired by QR) and connects it to the agent:
//   inbound:  every text message from an allowed number -> POST {AGENT_URL}/canal/whatsapp
//             { id, chat, numero, texto } with "Authorization: Bearer {BRIDGE_TOKEN}"
//   outbound: the agent calls POST /enviar { chat, texto } and POST /escribiendo { chat, listo? } here, same bearer.
// Env: BRIDGE_TOKEN (required), AGENT_URL (default http://127.0.0.1:3066), ALLOWED_NUMBERS (comma separated,
// digits with country code; empty = nobody), PORT (default 3037), AUTH_DIR (default ./auth).
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const TOKEN = process.env.BRIDGE_TOKEN ?? '';
const AGENT = (process.env.AGENT_URL ?? 'http://127.0.0.1:3066').replace(/\/$/, '');
const PORT = Number(process.env.PORT ?? 3037);
const AUTH_DIR = process.env.AUTH_DIR ?? './auth';
const digits = (x) => String(x ?? '').replace(/\D/g, '');
// Mexico: WhatsApp may report 521 + 10 digits or 52 + 10 digits for the same number.
const norm = (d) => (d.startsWith('521') && d.length === 13 ? '52' + d.slice(3) : d);
const ALLOWED = new Set(String(process.env.ALLOWED_NUMBERS ?? '').split(',').map(digits).filter(Boolean).map(norm));
if (!TOKEN) { console.error('BRIDGE_TOKEN is required'); process.exit(1); }

const log = pino({ level: 'warn' });
let sock = null;
const allowedChats = new Set();

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger: log, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { console.log('Scan this QR with the bot phone (WhatsApp > Linked devices):'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') console.log('WhatsApp connected');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { console.error('Logged out: delete', AUTH_DIR, 'and pair again'); process.exit(1); }
      setTimeout(connect, 2000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const chat = m.key.remoteJid ?? '';
      if (chat.endsWith('@g.us') || chat === 'status@broadcast') continue; // no groups
      // The sender number: from the phone-number JID, or from the LID mapping Baileys keeps.
      let pn = chat.endsWith('@s.whatsapp.net') ? chat : m.key.remoteJidAlt;
      if (!pn && chat.endsWith('@lid')) pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(chat).catch(() => null);
      const numero = norm(digits(String(pn ?? '').split('@')[0].split(':')[0]));
      if (!numero || !ALLOWED.has(numero)) continue;
      const texto = m.message.conversation ?? m.message.extendedTextMessage?.text ?? '';
      if (!texto.trim()) continue;
      allowedChats.add(chat);
      fetch(`${AGENT}/canal/whatsapp`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: m.key.id, chat, numero, texto: texto.trim(), at: new Date(Number(m.messageTimestamp) * 1000).toISOString() }),
        signal: AbortSignal.timeout(15000),
      }).catch((e) => console.error('agent unreachable:', e.message));
    }
  });
}

function authorized(req) {
  const t = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const k = Buffer.from(TOKEN);
  return t.length === k.length && timingSafeEqual(t, k);
}
function canWrite(chat) {
  if (allowedChats.has(chat)) return true;
  const d = norm(digits(String(chat).split('@')[0]));
  return chat.endsWith('@s.whatsapp.net') && ALLOWED.has(d);
}
async function body(req) { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; }

http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/salud') return send(200, { ok: true, connected: !!sock?.user });
  if (!authorized(req)) return send(401, { error: 'unauthorized' });
  if (req.method !== 'POST') return send(405, { error: 'method' });
  try {
    const b = await body(req);
    if (!b.chat || !canWrite(b.chat)) return send(403, { error: 'chat not allowed' });
    if (req.url === '/enviar') { const r = await sock.sendMessage(b.chat, { text: String(b.texto ?? '').slice(0, 4000) }); return send(200, { ids: [r?.key?.id] }); }
    if (req.url === '/escribiendo') { await sock.sendPresenceUpdate(b.listo ? 'paused' : 'composing', b.chat).catch(() => {}); return send(200, {}); }
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: String(e?.message ?? e) }); }
}).listen(PORT, '127.0.0.1', () => console.log(`bridge on 127.0.0.1:${PORT}, agent ${AGENT}, ${ALLOWED.size} allowed numbers`));

connect();
