// Congela la evidencia real de la noche en landing/prueba.json: órdenes de Reap, recibos y transacciones en Ink
// Sepolia. La página /prueba la lee sin token y sigue funcionando cuando la llave del sandbox vence.
import { writeFileSync } from 'node:fs';
import { db } from '../src/db.js';

const J = (x: any) => (x ? JSON.parse(x) : null);
const permisos = (db.prepare('SELECT * FROM permisos ORDER BY creado').all() as any[]).map(p => ({ ...p, contexto: J(p.contexto), onchain: J(p.onchain), gastador: J(p.gastador) }));
const compras = db.prepare(`SELECT c.*, q.producto, q.tienda FROM compras c LEFT JOIN cotizaciones q ON q.id = c.cotizacion_id ORDER BY c.creado`).all() as any[];
const eventos = (db.prepare(`SELECT * FROM eventos WHERE tipo IN ('onchain_liberado','decision_politica','bloqueada','sin_manos','permiso_cerrado','compra_estado','excepcion_aprobada','prueba_tienda') ORDER BY id`).all() as any[]).map(e => ({ ...e, detalle: J(e.detalle) }));

const txs: { tipo: string; tx: string; permiso: string; detalle: string; ts: string }[] = [];
const add = (tipo: string, tx: string | null | undefined, permiso: string, detalle: string, ts: string) => { if (tx && /^0x[0-9a-f]{64}$/i.test(tx) && !txs.some(t => t.tx === tx)) txs.push({ tipo, tx, permiso, detalle, ts }); };
for (const p of permisos) {
  if (p.onchain?.txCreacion) add('Fondo bloqueado en el contrato', p.onchain.txCreacion, p.titulo, `${p.onchain.usdcBloqueado} USDC · ${p.onchain.escalaTexto ?? p.onchain.escala ?? ''}`, p.creado);
  if (p.onchain?.txCierre) add('Cierre: sobrante devuelto', p.onchain.txCierre, p.titulo, `sobrante ${p.sobrante} ${p.moneda}`, p.cerrado);
}
for (const e of eventos) {
  const p = permisos.find(x => x.id === e.permiso_id); const t = p?.titulo ?? '';
  if (e.tipo === 'onchain_liberado') add('Liberación exacta al completarse la compra', e.detalle.tx, t, `${e.detalle.monto} ${p?.moneda ?? 'USD'}`, e.ts);
  if (e.tipo === 'sin_manos' && e.detalle.paso === 'contrato_libero') add('Liberación a la bóveda Kwal (sin manos)', e.detalle.detalle?.tx, t, `${e.detalle.detalle?.usdc} USDC`, e.ts);
}
for (const c of compras) if (c.estado === 'COMPLETED' && c.tx) add('Recibo registrado en la cadena', c.tx, permisos.find(x => x.id === c.permiso_id)?.titulo ?? '', `huella ${String(c.recibo_hash).slice(0, 18)}…`, c.actualizado);

const completadas = compras.filter(c => c.estado === 'COMPLETED').map(c => {
  const p = permisos.find(x => x.id === c.permiso_id);
  return { fecha: c.actualizado, permiso: p?.titulo, financiador: p?.financiador, producto: J(c.producto)?.nombre ?? null, tienda: c.tienda, monto: c.monto, moneda: c.moneda, orden: c.orden, via: c.id.startsWith('pay_') ? 'Kwal (bóveda, sin aprobación humana)' : 'Reap Agentic checkout', reciboHash: c.recibo_hash, tx: c.tx };
});
const decisiones = eventos.filter(e => e.tipo === 'decision_politica').map(e => ({ fecha: e.ts, decision: e.detalle.decision, razon: e.detalle.razon, confianza: e.detalle.confianza }));
const bloqueos = [...eventos.filter(e => e.tipo === 'bloqueada').map(e => ({ fecha: e.ts, razones: e.detalle.razones })), ...eventos.filter(e => e.tipo === 'prueba_tienda' && e.detalle.veredicto === 'fuera_de_reglas').map(e => ({ fecha: e.ts, razones: [`${e.detalle.tienda}: ${e.detalle.producto} rechazado por la regla (tienda y categoría no permitidas)`] }))];
const contratoBloqueo = eventos.filter(e => e.tipo === 'sin_manos' && JSON.stringify(e.detalle).includes('PasaDelTope')).length;

const distribuidores = permisos.filter(p => p.plantilla === 'mdf' && typeof p.contexto?.kwal === 'string').map(p => {
  const cs = compras.filter(c => c.permiso_id === p.id);
  return { socio: p.contexto.socio, tope: p.tope, boveda: p.onchain?.bovedaKwal, txFondeo: p.onchain?.txCreacion, compras: cs.map(c => ({ estado: c.estado, monto: c.monto, producto: J(c.producto)?.nombre ?? null, tx: c.tx })) };
});

const out = {
  generado: new Date().toISOString(),
  contrato: '0x931e92fe62310bc67ffe016c3c8f55afd31f7c69', red: 'Ink Sepolia (chain 763373)', explorador: 'https://explorer-sepolia.inkonchain.com',
  resumen: { permisos: permisos.length, comprasCompletadas: completadas.length, viaKwal: completadas.filter(c => c.via.startsWith('Kwal')).length, viaReap: completadas.filter(c => c.via.startsWith('Reap')).length, transaccionesEnCadena: txs.length, decisionesDePolitica: decisiones.length, bloqueosPorRegla: bloqueos.length, bloqueosDelContrato: contratoBloqueo },
  completadas, distribuidores, transacciones: txs.sort((a, b) => a.ts.localeCompare(b.ts)), decisiones, bloqueos: bloqueos.slice(-10),
};
writeFileSync('landing/prueba.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.resumen));
