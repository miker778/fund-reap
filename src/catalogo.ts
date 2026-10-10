// Lista oficial de comercios de Reap (catalogo/comercios.csv). Reap no devuelve categoría en la búsqueda,
// así que la categoría sale de aquí, por dominio.
import { readFileSync } from 'node:fs';

export type Comercio = { dominio: string; categoria: string; mercado: string; enviaA: string[]; moneda: string; productoPrueba: string; precio: number };

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

const [head, ...body] = parseCsv(readFileSync(new URL('../catalogo/comercios.csv', import.meta.url), 'utf8'));
const col = (n: string) => head.indexOf(n);

export const comercios: Comercio[] = body.map(r => ({
  dominio: r[col('Merchant door')],
  categoria: r[col('Category')],
  mercado: r[col('Market')],
  enviaA: r[col('Ships to')].split(',').map(s => s.trim()),
  moneda: r[col('Currency')],
  productoPrueba: r[col('Test product')],
  precio: Number(r[col('Item price')]) || 0,
}));

export const porDominio = new Map(comercios.map(c => [c.dominio, c]));

export function enviaA(c: Comercio, pais: string) {
  return c.enviaA.includes(pais) || c.enviaA.includes('*');
}

// Tiendas que cumplen categorías, moneda y país de envío.
export function tiendasPara(categorias: string[], pais: string, moneda = 'USD') {
  return comercios.filter(c => categorias.includes(c.categoria) && c.moneda === moneda && enviaA(c, pais)).map(c => c.dominio);
}
