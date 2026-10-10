// Track 2: el permiso vive también en el contrato Permisos en Ink Sepolia (USDC de prueba).
// Crear deposita el tope; cada compra libera exactamente su monto hacia la bóveda Kwal de quien gasta;
// el recibo queda como evento; cerrar regresa el sobrante a quien pagó. Si no hay CONTRACT_ADDRESS, no hace nada.
import { createPublicClient, createWalletClient, http, keccak256, toHex, parseUnits, type Hex } from 'viem';
import { inkSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import * as s from './servicio.js';
import { evento } from './db.js';
import { participante } from './kwal.js';

const { abi } = JSON.parse(readFileSync(new URL('../contratos/Permisos.json', import.meta.url), 'utf8'));
export const USDC = '0xFabab97dCE620294D2B0b0e46C68964e326300Ac' as const; // USDC de prueba de Circle en Ink Sepolia
export const EXPLORADOR = 'https://explorer-sepolia.inkonchain.com';
const erc20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const transport = http(process.env.INK_RPC_URL ?? 'https://rpc-gel-sepolia.inkonchain.com');
export const pub = createPublicClient({ chain: inkSepolia, transport });

function cliente() {
  const key = process.env.DEPLOYER_KEY as Hex | undefined;
  if (!key) return null;
  const account = privateKeyToAccount(key);
  return { account, wal: createWalletClient({ account, chain: inkSepolia, transport }) };
}

// La escala del sandbox: 1 USD del permiso = 0.01 USDC en la cadena, para que 20 USDC de faucet alcancen para
// muchos permisos. Se dice así en el demo y en el README.
export const ESCALA = 100;
const escalaDe = (p: s.Permiso) => Number((p.onchain as any)?.escala ?? ((p.contexto as any)?.kwal ? 1 : ESCALA));
const aUsdc = (usd: number, escala = ESCALA) => parseUnits((usd / escala).toFixed(6), 6);
const idDe = (permisoId: string) => keccak256(toHex(permisoId));

// Cola: una transacción a la vez desde la misma cuenta, para que no choquen los nonces.
let cola: Promise<unknown> = Promise.resolve();
function enCola<T>(f: () => Promise<T>): Promise<T> {
  const r = cola.then(f, f);
  cola = r.catch(() => {});
  return r;
}

async function enviar(functionName: string, args: unknown[], address: Hex) {
  const c = cliente()!;
  // El RPC público a veces no ve todavía el approve recién confirmado: se reintenta unos segundos.
  let hash: Hex | undefined;
  for (let i = 0; ; i++) {
    try { hash = await c.wal.writeContract({ address, abi, functionName, args } as any); break; }
    catch (e) { if (i < 10 && String(e).includes('allowance')) { await new Promise(r => setTimeout(r, 3000)); continue; } throw e; }
  }
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (r.status !== 'success') throw new Error(`tx ${functionName} falló: ${hash}`);
  return hash;
}

export function activar() {
  const contrato = process.env.CONTRACT_ADDRESS as Hex | undefined;
  const c = cliente();
  if (!contrato || !c) return false;
  const gastadorVault = (process.env.KWAL_VAULT ?? c.account.address) as Hex;

  // La bóveda a la que libera el contrato: la del participante Kwal del distribuidor, si tiene uno propio.
  const bovedaDe = (p: s.Permiso): Hex => {
    const k = (p.contexto as any)?.kwal;
    if (typeof k === 'string') { const v = participante(k)?.vault; if (v) return v as Hex; }
    return gastadorVault;
  };

  s.ganchos.onchainCrear = p => enCola(async () => {
    const escala = escalaDe(p);
    const tope = aUsdc(p.tope, escala);
    const aprobar = await c.wal.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [contrato, tope] });
    await pub.waitForTransactionReceipt({ hash: aprobar, timeout: 90_000 });
    const reglas = keccak256(toHex(JSON.stringify(p.reglas)));
    const tx = await enviar('crear', [idDe(p.id), bovedaDe(p), c.account.address, tope, BigInt(Math.floor(new Date(p.vence).getTime() / 1000)), reglas], contrato);
    return { contrato, cadena: 'ink-sepolia', idOnchain: idDe(p.id), txCreacion: tx, usdcBloqueado: Number(tope) / 1e6, bovedaKwal: bovedaDe(p), escala, escalaTexto: `1 USD = ${1 / escala} USDC` };
  });

  s.ganchos.onchainAutorizar = (p, monto, cotizacionId) => enCola(async () => {
    if (!p.onchain?.idOnchain) return null;
    return enviar('autorizar', [p.onchain.idOnchain, aUsdc(monto, escalaDe(p)), keccak256(toHex(cotizacionId))], contrato);
  });

  s.ganchos.onchainAprobar = (p, extra, cotizacionId) => enCola(async () => {
    if (!p.onchain?.idOnchain) return null;
    const monto = aUsdc(extra, escalaDe(p));
    const ap = await c.wal.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [contrato, monto] });
    await pub.waitForTransactionReceipt({ hash: ap, timeout: 90_000 });
    return enviar('aprobar', [p.onchain.idOnchain, monto, keccak256(toHex(cotizacionId))], contrato);
  });

  s.ganchos.onchainRecibo = (p, compraId, hash) => enCola(async () => {
    if (!p.onchain?.idOnchain) return null;
    return enviar('recibo', [p.onchain.idOnchain, keccak256(toHex(compraId)), hash as Hex], contrato);
  });

  s.ganchos.onchainCerrar = p => enCola(async () => {
    if (!p.onchain?.idOnchain) return null;
    return enviar('cerrar', [p.onchain.idOnchain], contrato);
  });

  evento(null, 'onchain_activo', { contrato, boveda: gastadorVault });
  return true;
}

export async function saldoUsdc(dir: Hex) {
  return Number(await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [dir] })) / 1e6;
}
