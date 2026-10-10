// Cliente de demo del sandbox: una tarjeta inscrita en Reap (DEMO_ENROLLMENT_ID) y una dirección de prueba en CDMX.
import type { Gastador } from './servicio.js';

export function gastadorDemo(): Gastador {
  return {
    nombre: 'Ana López',
    email: 'ana.lopez@example.com',
    telefono: '+525512345678',
    enrollmentId: process.env.DEMO_ENROLLMENT_ID ?? '',
    direccion: {
      firstName: 'Ana', lastName: 'López', phone: '+525512345678',
      addressLine1: 'Av. Presidente Masaryk 111', city: 'Ciudad de México', region: 'CMX', postalCode: '11560', country: 'MX',
    },
  };
}

// Escenarios de un clic para la consola y la página de demo: siempre hay un permiso fresco para enseñar.
export const ESCENARIOS = {
  reclamo: { plantilla: 'reposicion' as const, titulo: 'Reposición de audífonos robados', financiador: 'Aseguradora Demo', tope: 120, contexto: (n: string) => ({ siniestro: 'CLM-' + n, articulo: 'Audífonos inalámbricos' }) },
  reclamo_estricto: { plantilla: 'reposicion' as const, titulo: 'Reposición de audífonos (política: preguntar)', financiador: 'Aseguradora Demo', tope: 120, contexto: (n: string) => ({ siniestro: 'CLM-' + n, articulo: 'Audífonos inalámbricos', politica: { modo: 'preguntar' } }) },
  fondo: { plantilla: 'mdf' as const, titulo: 'Fondo co-op Q4 · Distribuidora Norte', financiador: 'Marca Demo', tope: 150, contexto: (n: string) => ({ socio: 'Distribuidora Norte', lote: n }) },
  fondo_kwal: { plantilla: 'mdf' as const, titulo: 'Fondo co-op (paga la bóveda Kwal, sin manos)', financiador: 'Marca Demo', tope: 60, contexto: (n: string) => ({ socio: 'Distribuidora Sur', lote: n, kwal: true }) },
};

// Distribuidores de la marca (Estados Unidos: el envío de artículos chicos cuesta centavos en el sandbox de Kwal).
export const DISTRIBUIDORES = [
  { kwal: 'norte', socio: 'Distribuidora Norte', ciudad: 'New York', region: 'NY', postal: '10118', linea: '350 5th Ave' },
  { kwal: 'sur', socio: 'Distribuidora Sur', ciudad: 'Austin', region: 'TX', postal: '78701', linea: '100 Congress Ave' },
  { kwal: 'bajio', socio: 'Distribuidora Bajío', ciudad: 'San Diego', region: 'CA', postal: '92101', linea: '600 B St' },
];

export function gastadorDistribuidor(d: typeof DISTRIBUIDORES[number]): Gastador {
  return {
    nombre: d.socio, email: `${d.kwal}@example.com`, telefono: '+12125550100', enrollmentId: process.env.DEMO_ENROLLMENT_ID ?? '',
    direccion: { firstName: d.socio.split(' ')[0], lastName: d.socio.split(' ').slice(1).join(' ') || 'Socio', phone: '+12125550100', addressLine1: d.linea, city: d.ciudad, region: d.region, postalCode: d.postal, country: 'US' },
  };
}

// Cartera simulada para enseñar escala junto a los distribuidores reales; la página la marca como simulada.
export function carteraSimulada() {
  const nombres = ['Tecno Norte', 'Distribuidora Pacífico', 'Grupo Occidente', 'Electro Centro', 'Red Sureste', 'Mayoreo Golfo', 'Comercial Bajío', 'Cómputo Laguna', 'Audio Total', 'Oficina Plus', 'Digital Noreste', 'Canal Peninsular', 'Conecta Sur', 'Mundo Gamer', 'Socio Valle', 'Punto Tech', 'Megacanal', 'Distribuciones Altiplano', 'Tienda Hub', 'Frontera Digital'];
  let s = 7;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  return nombres.map(n => {
    const tope = [2000, 3000, 5000, 7500][Math.floor(r() * 4)];
    const uso = 0.35 + r() * 0.6;
    const compras = Math.floor(6 + r() * 40);
    const excepciones = Math.floor(r() * 4);
    return { socio: n, tope, gastado: Math.round(tope * uso), compras, excepciones, autoAprobadas: Math.max(0, excepciones - Math.floor(r() * 2)), bloqueos: Math.floor(r() * 3), simulado: true };
  });
}
