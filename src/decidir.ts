// La decisión del financiador sobre una excepción. Patrón de la casa (agentes por evento): una llamada tipada y barata
// (DECISION_MODEL; nosotros usamos Jev, un enrutador tipado) decide contra la política; sólo lo que no alcanza confianza se escala a una
// persona. Nunca un modelo de chat con herramientas.
import { config } from './config.js';

export type Politica = {
  modo: 'auto' | 'preguntar';   // auto: Jev decide; preguntar: todo se escala a la persona
  margenAuto: number;           // 0.2 = aprueba solo hasta 20% arriba del saldo
  exigirMasBarata: boolean;     // sólo aprueba si es la opción más barata equivalente
  rechazar: string[];           // p. ej. ['upgrade', 'tienda_fuera_de_lista']
  confianzaMinima: number;      // debajo de esto se escala
};

export const POLITICA_BASE: Politica = { modo: 'auto', margenAuto: 0.2, exigirMasBarata: true, rechazar: ['upgrade'], confianzaMinima: 0.75 };

export type Decision = { decision: 'aprobar' | 'rechazar' | 'escalar'; razon: string; confianza: number; quien: 'politica' | 'persona' };

export type Hechos = {
  saldo: number; total: number; diferencia: number; producto: string; tienda: string;
  esLaMasBarata: boolean | null; categoriaPermitida: boolean; comprasPrevias: number; financiador: string;
};

export async function decidirExcepcion(politica: Politica, hechos: Hechos): Promise<Decision> {
  if (politica.modo === 'preguntar') return { decision: 'escalar', razon: 'La política pide que una persona decida cada excepción.', confianza: 1, quien: 'politica' };
  // Reglas duras primero, sin modelo: lo que la política rechaza de plano.
  if (!hechos.categoriaPermitida) return { decision: 'rechazar', razon: 'La categoría no está en la política.', confianza: 1, quien: 'politica' };
  const limite = hechos.saldo * (1 + politica.margenAuto);
  if (hechos.total > limite) return { decision: 'escalar', razon: `Pasa del margen automático (${Math.round(politica.margenAuto * 100)}%): ${hechos.total} contra ${limite.toFixed(2)}.`, confianza: 1, quien: 'politica' };
  if (!config.llmKey) return { decision: 'escalar', razon: 'Sin modelo de decisión configurado.', confianza: 0, quien: 'politica' };
  const body = {
    model: config.decisionModel, temperature: 0,
    response_format: { type: 'json_schema', json_schema: { name: 'decision', schema: { type: 'object', properties: { decision: { enum: ['aprobar', 'rechazar', 'escalar'] }, razon: { type: 'string' }, confianza: { type: 'number' } }, required: ['decision', 'razon', 'confianza'], additionalProperties: false } } },
    messages: [
      { role: 'system', content: 'Decides excepciones de compra a nombre de quien paga, según su política. Aprueba sólo si cabe en el margen y cumple las condiciones; rechaza lo que la política rechaza; escala lo dudoso. Razón en una frase, en español. Responde sólo JSON.' },
      { role: 'user', content: JSON.stringify({ politica: { margen_auto: politica.margenAuto, exigir_mas_barata: politica.exigirMasBarata, rechazar: politica.rechazar }, excepcion: hechos }) },
    ],
  };
  const r = await fetch(`${config.llmUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.llmKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(50_000) });
  if (!r.ok) return { decision: 'escalar', razon: `El modelo de decisión no respondió (${r.status}).`, confianza: 0, quien: 'politica' };
  const j: any = await r.json();
  let d: any;
  try { d = JSON.parse(j.choices[0].message.content); } catch { return { decision: 'escalar', razon: 'Respuesta de decisión ilegible.', confianza: 0, quien: 'politica' }; }
  const conf = Number(d.confianza ?? 0);
  if (conf < politica.confianzaMinima && d.decision !== 'escalar') return { decision: 'escalar', razon: `${d.razon} (confianza ${conf.toFixed(2)}, debajo del mínimo).`, confianza: conf, quien: 'politica' };
  return { decision: d.decision, razon: String(d.razon), confianza: conf, quien: 'politica' };
}
