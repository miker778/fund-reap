import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluar, type PermisoParaReglas } from '../src/reglas.js';

const p: PermisoParaReglas = {
  estado: 'activo',
  tope: 120,
  vence: '2099-01-01T00:00:00Z',
  reglas: { tiendas: ['linsoul.com', 'headphones.com'], categorias: ['Audio & Music'], moneda: 'USD', cantidadMax: 1, margenAprobacion: 0.5 },
};
const base = { total: 95.99, moneda: 'USD', tienda: 'linsoul.com', categoria: 'Audio & Music', cantidad: 1 };

test('dentro del saldo: ok', () => {
  assert.equal(evaluar(p, 0, base).tipo, 'ok');
});

test('el envío cuenta: 115 + 6 pasa del tope de 120', () => {
  const v = evaluar(p, 0, { ...base, total: 121 });
  assert.equal(v.tipo, 'requiere_aprobacion');
});

test('lo ya gastado baja el saldo', () => {
  const v = evaluar(p, 100, base);
  assert.equal(v.tipo, 'fuera_de_reglas'); // saldo 20, límite con margen 30
});

test('arriba del saldo pero dentro del margen: pide aprobación con la diferencia', () => {
  const v = evaluar(p, 0, { ...base, total: 150 });
  assert.equal(v.tipo, 'requiere_aprobacion');
  if (v.tipo === 'requiere_aprobacion') assert.equal(v.diferencia, 30);
});

test('arriba del margen: fuera de reglas aunque se apruebe', () => {
  assert.equal(evaluar(p, 0, { ...base, total: 181 }).tipo, 'fuera_de_reglas');
});

test('aprobada hasta un monto: pasa si no se movió el precio', () => {
  assert.equal(evaluar(p, 0, { ...base, total: 150, aprobada: true, montoAprobado: 150 }).tipo, 'ok');
  assert.equal(evaluar(p, 0, { ...base, total: 155, aprobada: true, montoAprobado: 150 }).tipo, 'requiere_aprobacion');
});

test('tienda no permitida', () => {
  const v = evaluar(p, 0, { ...base, tienda: 'amazon.com' });
  assert.equal(v.tipo, 'fuera_de_reglas');
});

test('categoría no permitida', () => {
  assert.equal(evaluar(p, 0, { ...base, categoria: 'Coffee & Tea' }).tipo, 'fuera_de_reglas');
});

test('moneda distinta', () => {
  assert.equal(evaluar(p, 0, { ...base, moneda: 'MXN' }).tipo, 'fuera_de_reglas');
});

test('vencido', () => {
  assert.equal(evaluar({ ...p, vence: '2020-01-01T00:00:00Z' }, 0, base).tipo, 'fuera_de_reglas');
});

test('cerrado', () => {
  assert.equal(evaluar({ ...p, estado: 'cerrado' }, 0, base).tipo, 'fuera_de_reglas');
});

test('cantidad', () => {
  assert.equal(evaluar(p, 0, { ...base, cantidad: 2 }).tipo, 'fuera_de_reglas');
});
