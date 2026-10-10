// SQLite (node:sqlite). Un archivo en data/, fuera del repo.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(`${config.dataDir}/permiso.db`);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS permisos (
  id TEXT PRIMARY KEY,
  plantilla TEXT NOT NULL,
  titulo TEXT NOT NULL,
  financiador TEXT NOT NULL,
  gastador TEXT NOT NULL,       -- JSON: nombre, email, telefono, direccion, enrollmentId
  tope REAL NOT NULL,
  moneda TEXT NOT NULL,
  reglas TEXT NOT NULL,         -- JSON (ver reglas.ts)
  contexto TEXT NOT NULL,       -- JSON: siniestro, articulo, socio...
  vence TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activo',
  token TEXT NOT NULL UNIQUE,   -- enlace de capacidad del gastador
  onchain TEXT,                 -- JSON: contrato, id, txs
  creado TEXT NOT NULL,
  cerrado TEXT,
  sobrante REAL
);
CREATE TABLE IF NOT EXISTS cotizaciones (
  id TEXT PRIMARY KEY,          -- id de la cotización en Reap
  permiso_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  producto TEXT NOT NULL,       -- JSON: id, nombre, variante, tienda, imagen
  tienda TEXT NOT NULL,
  total REAL NOT NULL,
  moneda TEXT NOT NULL,
  desglose TEXT NOT NULL,       -- JSON de amountBreakdown
  veredicto TEXT NOT NULL,      -- JSON
  vence TEXT NOT NULL,
  creado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS excepciones (
  id TEXT PRIMARY KEY,
  permiso_id TEXT NOT NULL,
  cotizacion_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  monto REAL NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | aprobada | rechazada
  nota TEXT,
  creado TEXT NOT NULL,
  resuelto TEXT
);
CREATE TABLE IF NOT EXISTS compras (
  id TEXT PRIMARY KEY,          -- id del checkout en Reap
  permiso_id TEXT NOT NULL,
  cotizacion_id TEXT NOT NULL,
  estado TEXT NOT NULL,
  monto REAL NOT NULL,
  moneda TEXT NOT NULL,
  orden TEXT,
  url TEXT,
  recibo TEXT,                  -- JSON del recibo
  recibo_hash TEXT,
  tx TEXT,                      -- tx onchain del recibo, si aplica
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  permiso_id TEXT,
  tipo TEXT NOT NULL,
  detalle TEXT NOT NULL,
  ts TEXT NOT NULL
);
`);

export const ahora = () => new Date().toISOString();

export function evento(permisoId: string | null, tipo: string, detalle: unknown) {
  db.prepare('INSERT INTO eventos (permiso_id, tipo, detalle, ts) VALUES (?, ?, ?, ?)').run(permisoId, tipo, JSON.stringify(detalle), ahora());
}
