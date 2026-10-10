// Toda la configuración llega por variables de entorno (ver .env.example).
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`falta ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3066),
  publicUrl: process.env.PUBLIC_URL ?? 'http://127.0.0.1:3066',
  reapBaseUrl: process.env.REAP_BASE_URL ?? 'https://sg.sandbox.api.reap.global',
  reapApiKey: () => process.env.REPLAY === '1' ? 'replay' : req('REAP_API_KEY'),
  funderToken: () => process.env.REPLAY === '1' ? (process.env.FUNDER_TOKEN ?? 'demo') : req('FUNDER_TOKEN'),
  accessCode: () => process.env.ACCESS_CODE ?? (process.env.REPLAY === '1' ? 'demo' : ''),
  // Cualquier proveedor compatible con la API de OpenAI (chat completions).
  llmUrl: (process.env.LLM_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, ''),
  llmKey: process.env.LLM_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  decisionModel: process.env.DECISION_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini',
  // Puente de WhatsApp (bridge/ en este repo, o cualquiera que cumpla el contrato).
  bridgeUrl: process.env.WHATSAPP_BRIDGE_URL ?? 'http://127.0.0.1:3037',
  bridgeToken: process.env.WHATSAPP_BRIDGE_TOKEN ?? '',
  dataDir: process.env.DATA_DIR ?? new URL('../data/', import.meta.url).pathname,
};
