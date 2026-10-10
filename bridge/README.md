# Permiso WhatsApp bridge

A minimal WhatsApp bridge (Baileys). It holds one WhatsApp session paired by QR and connects it to the Permiso agent.

```
cd bridge
npm install
BRIDGE_TOKEN=change-me AGENT_URL=http://127.0.0.1:3066 ALLOWED_NUMBERS=5215512345678,5217711234567 npm start
```

Scan the QR with the phone of the number that will act as the bot (WhatsApp > Linked devices). Then start the agent with the same token: `WHATSAPP_BRIDGE_URL=http://127.0.0.1:3037 WHATSAPP_BRIDGE_TOKEN=change-me FUNDER_WHATSAPP=<funder chat>`.

Contract with the agent:

- Inbound: `POST {AGENT_URL}/canal/whatsapp` with `Authorization: Bearer <token>` and `{ id, chat, numero, texto, at }`, for text messages from allowed numbers only. Groups are ignored.
- Outbound: the agent calls `POST /enviar { chat, texto }` and `POST /escribiendo { chat, listo? }` with the same bearer. The bridge only writes to allowed numbers or chats it has seen from them.

Any other WhatsApp provider (for example the WhatsApp Cloud API) can replace this bridge by implementing the same two calls.
