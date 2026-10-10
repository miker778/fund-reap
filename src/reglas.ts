// Motor de reglas. Puro: recibe el permiso, lo gastado y la cotización, y devuelve el veredicto.
// El modelo nunca decide; las herramientas devuelven lo que diga esto.

export type Reglas = {
  tiendas: string[];          // dominios permitidos
  categorias: string[];       // categorías del catálogo de Reap
  moneda: string;             // moneda del permiso; cotizaciones en otra moneda no pasan
  cantidadMax: number;        // piezas por compra
  margenAprobacion: number;   // 0.5 = hasta 50% arriba del saldo se puede pedir aprobación; más que eso, no
};

export type PermisoParaReglas = {
  estado: 'activo' | 'cerrado';
  tope: number;
  vence: string;              // ISO
  reglas: Reglas;
};

export type Veredicto =
  | { tipo: 'ok'; saldo: number; total: number }
  | { tipo: 'requiere_aprobacion'; saldo: number; total: number; diferencia: number; razones: string[] }
  | { tipo: 'fuera_de_reglas'; saldo: number; total: number; razones: string[] };

export type Intento = {
  total: number;              // monto final de la cotización: artículo + envío + impuestos - descuentos
  moneda: string;
  tienda: string;             // dominio
  categoria: string | null;
  cantidad: number;
  aprobada?: boolean;         // el financiador ya aprobó esta excepción
  montoAprobado?: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function saldo(p: PermisoParaReglas, gastado: number) {
  return r2(Math.max(0, p.tope - gastado));
}

export function evaluar(p: PermisoParaReglas, gastado: number, i: Intento, ahora = new Date()): Veredicto {
  const s = saldo(p, gastado);
  const total = r2(i.total);
  const duras: string[] = [];
  if (p.estado !== 'activo') duras.push('el permiso está cerrado');
  if (new Date(p.vence).getTime() <= ahora.getTime()) duras.push(`el permiso venció el ${p.vence.slice(0, 10)}`);
  if (!p.reglas.tiendas.includes(i.tienda)) duras.push(`la tienda ${i.tienda} no está permitida`);
  if (!i.categoria || !p.reglas.categorias.includes(i.categoria)) duras.push(`la categoría ${i.categoria ?? 'desconocida'} no está permitida`);
  if (i.moneda !== p.reglas.moneda) duras.push(`la cotización viene en ${i.moneda} y el permiso es en ${p.reglas.moneda}`);
  if (i.cantidad > p.reglas.cantidadMax) duras.push(`máximo ${p.reglas.cantidadMax} pieza(s) por compra`);
  if (duras.length) return { tipo: 'fuera_de_reglas', saldo: s, total, razones: duras };

  if (total <= s) return { tipo: 'ok', saldo: s, total };
  if (i.aprobada && i.montoAprobado !== undefined && total <= r2(i.montoAprobado)) return { tipo: 'ok', saldo: s, total };

  const diferencia = r2(total - s);
  const limite = r2(s * (1 + p.reglas.margenAprobacion));
  if (total > limite) {
    return { tipo: 'fuera_de_reglas', saldo: s, total, razones: [`cuesta ${total} y el saldo es ${s}; ni con aprobación pasa de ${limite}`] };
  }
  return { tipo: 'requiere_aprobacion', saldo: s, total, diferencia, razones: [`cuesta ${total}, ${diferencia} arriba del saldo de ${s}`] };
}
