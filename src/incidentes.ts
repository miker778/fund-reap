// Incidentes: una compra aprobada que la tienda no confirma. Reloj de 15 minutos (aviso a los dos lados), vencimiento a
// 24 horas (se libera el saldo, nadie pagó), y la tienda que se atora se ofrece al final.
import { db, ahora, evento } from './db.js';
import * as s from './servicio.js';

const AVISO_MIN = 15, VENCE_H = 24;

export function incidentes() {
  return (db.prepare(`SELECT c.*, p.titulo, p.financiador, q.tienda, q.producto FROM compras c JOIN permisos p ON p.id = c.permiso_id
    LEFT JOIN cotizaciones q ON q.id = c.cotizacion_id WHERE c.estado = 'PROCESSING' AND c.creado < datetime('now', '-${AVISO_MIN} minutes') ORDER BY c.creado`).all() as any[])
    .map(c => ({ compraId: c.id, permisoId: c.permiso_id, permiso: c.titulo, financiador: c.financiador, tienda: c.tienda, producto: c.producto ? JSON.parse(c.producto).nombre : null,
      monto: c.monto, moneda: c.moneda, orden: c.orden, desde: c.creado, minutos: Math.round((Date.now() - new Date(c.creado).getTime()) / 60000),
      estadoTexto: 'La tienda no ha confirmado; el dinero sigue sin moverse.' }));
}

// Tiendas con incidentes: se ofrecen al final en buscar_opciones.
export function tiendasAtoradas(): Set<string> {
  const r = db.prepare(`SELECT DISTINCT q.tienda FROM compras c JOIN cotizaciones q ON q.id = c.cotizacion_id
    WHERE c.estado IN ('PROCESSING', 'FAILED') AND c.creado < datetime('now', '-${AVISO_MIN} minutes')`).all() as any[];
  return new Set(r.map(x => x.tienda));
}

export function vigilarIncidentes() {
  db.exec(`CREATE TABLE IF NOT EXISTS incidentes_avisados (compra_id TEXT PRIMARY KEY, avisado TEXT NOT NULL)`);
  setInterval(async () => {
    try {
      for (const i of incidentes()) {
        const ya = db.prepare('SELECT 1 FROM incidentes_avisados WHERE compra_id = ?').get(i.compraId);
        const p = s.obtener(i.permisoId);
        if (!ya) {
          db.prepare('INSERT INTO incidentes_avisados (compra_id, avisado) VALUES (?, ?)').run(i.compraId, ahora());
          evento(p.id, 'incidente', { compra: i.compraId, tienda: i.tienda, minutos: i.minutos });
          await s.ganchos.avisarGastador(p, `La tienda (${i.tienda}) lleva ${i.minutos} minutos sin confirmar tu pedido. No se ha movido dinero. ¿Esperamos o eliges otra opción?`);
          await s.ganchos.avisarFinanciador(p, `[${p.financiador}] Incidente: ${i.tienda} no confirma la compra de ${p.gastador.nombre} (${i.monto} ${i.moneda}) tras ${i.minutos} min. El dinero no se movió.`);
        }
        if (i.minutos > VENCE_H * 60) {
          db.prepare(`UPDATE compras SET estado = 'EXPIRED', actualizado = ? WHERE id = ?`).run(ahora(), i.compraId);
          evento(p.id, 'incidente_vencido', { compra: i.compraId, tienda: i.tienda });
          await s.ganchos.avisarGastador(p, `La compra en ${i.tienda} no se confirmó en 24 horas. Se canceló, no se cobró y tu saldo vuelve a estar disponible.`);
        }
      }
    } catch (e) { console.error('incidentes', e); }
  }, 60_000);
}
