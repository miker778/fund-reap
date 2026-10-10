// Web mínima, sin framework: consola del financiador (/consola/<token>) y página del reclamo (/p/<token>).
// Las páginas llaman a la API REST con el mismo token del enlace.
import { Router } from 'express';
import { config } from './config.js';
import { igual } from './api.js';
import * as s from './servicio.js';

export const web = Router();

const CSS = `
:root{--tinta:#14161a;--suave:#5b6170;--linea:#e4e6eb;--fondo:#f6f5f1;--papel:#fff;--ok:#0f7b4a;--ok-f:#e3f4ea;--aviso:#9a5b00;--aviso-f:#fdf0d8;--no:#b42318;--no-f:#fde7e5;--acento:#1f3a8a}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--tinta);background:var(--fondo)}
header{display:flex;align-items:center;gap:.75rem;padding:1rem 1.5rem;border-bottom:1px solid var(--linea);background:var(--papel)}
.marca{font-weight:700;letter-spacing:-.01em}.marca b{color:var(--acento)}.etq{font-size:12px;color:var(--suave);border:1px solid var(--linea);border-radius:999px;padding:.1rem .6rem}
main{max-width:1080px;margin:0 auto;padding:1.5rem}h1{font-size:22px;margin:.2rem 0 1rem}h2{font-size:16px;margin:1.6rem 0 .6rem}
.grid{display:grid;gap:1rem}.g4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.card{background:var(--papel);border:1px solid var(--linea);border-radius:12px;padding:1rem}
.kpi .v{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}.kpi .l{color:var(--suave);font-size:13px}
.barra{height:8px;background:var(--linea);border-radius:99px;overflow:hidden;margin:.5rem 0}.barra i{display:block;height:100%;background:var(--acento)}
.muted{color:var(--suave);font-size:13px}.fila{display:flex;justify-content:space-between;gap:1rem;align-items:center}
.pill{font-size:12px;border-radius:999px;padding:.1rem .55rem;font-weight:600}.ok{background:var(--ok-f);color:var(--ok)}.aviso{background:var(--aviso-f);color:var(--aviso)}.no{background:var(--no-f);color:var(--no)}
button,.btn{font:inherit;border:1px solid var(--tinta);background:var(--tinta);color:#fff;border-radius:8px;padding:.45rem .9rem;cursor:pointer;text-decoration:none;display:inline-block}
button.sec{background:var(--papel);color:var(--tinta)}button:disabled{opacity:.5;cursor:default}
input,select{font:inherit;padding:.45rem .6rem;border:1px solid var(--linea);border-radius:8px;width:100%;background:#fff}
label{font-size:13px;color:var(--suave);display:block;margin:.4rem 0 .2rem}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:.45rem .4rem;border-bottom:1px solid var(--linea);vertical-align:top}th{color:var(--suave);font-weight:500;font-size:12px}
code{font-size:12px;background:#f0f1f4;padding:.05rem .3rem;border-radius:4px;word-break:break-all}
.op{display:flex;gap:.8rem;align-items:center}.op img{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#eee}
.aviso-caja{border-left:3px solid var(--acento);padding:.6rem .8rem;background:#eef2ff;border-radius:6px}
`;

const pagina = (titulo: string, cuerpo: string, script = '') => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} · Permiso</title><style>${CSS}</style></head>
<body><header><span class="marca">Per<b>miso</b></span><span class="etq">sandbox · sin dinero real</span></header><main>${cuerpo}</main>
<script>${script}</script></body></html>`;

const esc = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ---------- consola del financiador ----------

web.get('/consola/:token', (req, res) => {
  if (!igual(String(req.params.token), config.funderToken())) return res.status(404).send('no encontrado');
  res.type('html').send(pagina('Consola', `
<div class="fila"><h1>Consola del financiador</h1><span class="muted" id="act"></span></div>
<div class="grid g4" id="kpis"></div>
<h2>Transacciones</h2><div class="card"><table><thead><tr><th>Fecha</th><th>Permiso</th><th>Producto</th><th>Monto</th><th>Estado</th><th>Orden</th><th>Recibo</th><th></th></tr></thead><tbody id="trans"></tbody></table></div>
<h2>Incidentes</h2><div id="incidentes" class="grid"></div>
<h2>Excepciones por decidir</h2><div id="excepciones" class="grid"></div>
<h2>Permisos</h2><div id="permisos" class="grid g2"></div>
<h2>Crear permiso</h2>
<form id="crear" class="card grid g2">
 <div><label>Plantilla</label><select name="plantilla"><option value="reposicion">Reposición en especie (aseguradora, 7 días)</option><option value="mdf">Fondo co-op de socio (MDF, 90 días)</option></select></div>
 <div><label>Título</label><input name="titulo" value="Reposición de audífonos robados" required></div>
 <div><label>Tope (USD)</label><input name="tope" type="number" step="0.01" value="120" required></div>
 <div><label>Referencia (siniestro o socio)</label><input name="ref" value="CLM-002"></div>
 <div><label>Financiador</label><input name="financiador" value="Aseguradora Demo"></div>
 <div style="align-self:end"><button>Crear y obtener enlace</button></div>
 <div id="creado" style="grid-column:1/-1"></div>
</form>
<h2>Bitácora</h2><div class="card"><table><thead><tr><th>Hora</th><th>Permiso</th><th>Evento</th><th>Detalle</th></tr></thead><tbody id="eventos"></tbody></table></div>
`, `
const T=${JSON.stringify(String(req.params.token))};const H={Authorization:'Bearer '+T,'content-type':'application/json'};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>n==null?'—':'$'+Number(n).toFixed(2);
async function api(m,u,b){const r=await fetch('/v1'+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});return r.json()}
async function cargar(){
 const a=await api('GET','/auditoria');const m=a.marcador;
 document.getElementById('kpis').innerHTML=[['Permisos',m.permisos],['Compras',m.compras],['Sin intervención',m.sinIntervencion],['Excepciones',m.excepciones],['Bloqueos',m.bloqueos],['Gastado',money(m.gastado)],['Sobrante devuelto',money(m.sobranteDevuelto)],['Min. permiso→compra',m.minutosMedianaPermisoACompra??'—']].map(([l,v])=>'<div class="card kpi"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>').join('');
 const tr=await api('GET','/transacciones');
 document.getElementById('trans').innerHTML=tr.length?tr.map(t=>'<tr><td class="muted">'+esc(new Date(t.fecha).toLocaleString('es-MX',{dateStyle:'short',timeStyle:'short'}))+'</td><td>'+esc(t.permiso)+'</td><td>'+esc(t.producto||'')+'<div class="muted">'+esc(t.tienda||'')+'</div></td><td>'+money(t.monto)+'</td><td><span class="pill '+(t.estado==='COMPLETED'?'ok':t.estado==='FAILED'||t.estado==='EXPIRED'?'no':'aviso')+'">'+esc(t.estadoTexto)+'</span></td><td class="muted">'+esc(t.orden||'')+'</td><td>'+(t.reciboHash?'<code>'+esc(t.reciboHash.slice(0,12))+'</code>':'')+(t.tx?' <a target="_blank" href="https://explorer-sepolia.inkonchain.com/tx/'+esc(t.tx)+'">cadena</a>':'')+'</td><td><a href="/consola/'+T+'/compra/'+esc(t.permisoId)+'/'+esc(t.compraId)+'">ver</a></td></tr>').join(''):'<tr><td colspan="8" class="muted">Sin compras todavía.</td></tr>';
 const inc=await api('GET','/incidentes');
 document.getElementById('incidentes').innerHTML=inc.length?inc.map(i=>'<div class="card fila"><div><b>'+esc(i.tienda)+'</b> no confirma '+esc(i.producto||'la compra')+' ('+money(i.monto)+') desde hace '+i.minutos+' min<div class="muted">'+esc(i.permiso)+' · el dinero no se movió</div></div><a href="/consola/'+T+'/compra/'+esc(i.permisoId)+'/'+esc(i.compraId)+'">ver</a></div>').join(''):'<div class="muted">Ninguno. Todas las tiendas confirmaron a tiempo.</div>';
 const ex=await api('GET','/excepciones');
 document.getElementById('excepciones').innerHTML=ex.length?ex.map(e=>'<div class="card fila"><div><b>'+esc(e.titulo)+'</b><div class="muted">'+esc(e.motivo)+'</div></div><div style="display:flex;gap:.5rem;align-items:center"><b>'+money(e.monto)+'</b><button onclick="decidir(\\''+e.id+'\\',1)">Aprobar</button><button class="sec" onclick="decidir(\\''+e.id+'\\',0)">Rechazar</button></div></div>').join(''):'<div class="muted">Nada por decidir. Todo lo demás se compró dentro de las reglas.</div>';
 document.getElementById('permisos').innerHTML=a.permisos.map(p=>{const pct=Math.min(100,100*p.gastado/p.tope);const est=p.estado==='cerrado'?'<span class="pill ok">cerrado · sobrante '+money(p.sobrante)+'</span>':'<span class="pill aviso">activo</span>';
  const compras=p.compras.map(c=>'<tr><td>'+esc(c.recibo?.producto?.nombre||'')+'</td><td>'+money(c.monto)+'</td><td><span class="pill '+(c.estado==='COMPLETED'?'ok':c.estado==='FAILED'||c.estado==='EXPIRED'?'no':'aviso')+'">'+esc(c.estadoTexto||c.estado)+'</span></td><td><code>'+esc((c.recibo_hash||'').slice(0,18))+'</code>'+(c.tx?' <a href="https://explorer-sepolia.inkonchain.com/tx/'+esc(c.tx)+'" target="_blank">tx</a>':'')+'</td></tr>').join('');
  return '<div class="card"><div class="fila"><b>'+esc(p.titulo)+'</b>'+est+'</div><div class="muted">'+esc(p.plantilla==='mdf'?'Fondo co-op':'Reposición')+' · '+esc(p.contexto.siniestro||p.contexto.socio||'')+' · para '+esc(p.gastador.nombre)+' · vence '+esc(p.vence.slice(0,10))+'</div><div class="barra"><i style="width:'+pct+'%"></i></div><div class="fila muted"><span>Gastado '+money(p.gastado)+'</span><span>Saldo '+money(p.saldo)+' de '+money(p.tope)+'</span></div>'+(compras?'<table style="margin-top:.6rem"><tbody>'+compras+'</tbody></table>':'')+(p.onchain?.contrato?'<div class="muted" style="margin-top:.4rem">Contrato <code>'+esc(p.onchain.contrato)+'</code></div>':'')+(p.estado!=='cerrado'?'<div style="margin-top:.6rem"><button class="sec" onclick="cerrar(\\''+p.id+'\\')">Cerrar y devolver sobrante</button></div>':'')+'</div>'}).join('')||'<div class="muted">Sin permisos todavía.</div>';
 document.getElementById('eventos').innerHTML=a.eventos.slice(0,30).map(e=>'<tr><td class="muted">'+esc(e.ts.slice(11,19))+'</td><td><code>'+esc(e.permiso_id||'')+'</code></td><td>'+esc(e.tipo)+'</td><td class="muted">'+esc(JSON.stringify(e.detalle).slice(0,140))+'</td></tr>').join('');
 document.getElementById('act').textContent='actualizado '+new Date().toLocaleTimeString();
}
async function decidir(id,ok){await api('POST','/excepciones/'+id+'/'+(ok?'aprobar':'rechazar'),{});cargar()}
async function cerrar(id){if(confirm('¿Cerrar y devolver el sobrante?')){await api('POST','/permisos/'+id+'/cerrar');cargar()}}
document.getElementById('crear').onsubmit=async ev=>{ev.preventDefault();const f=Object.fromEntries(new FormData(ev.target));
 const ctx=f.plantilla==='mdf'?{socio:f.ref}:{siniestro:f.ref};
 const r=await api('POST','/permisos/demo',{plantilla:f.plantilla,titulo:f.titulo,tope:Number(f.tope),financiador:f.financiador,contexto:ctx});
 document.getElementById('creado').innerHTML=r.error?'<span class="pill no">'+esc(r.error)+'</span>':'<div class="aviso-caja">Listo. Enlace para quien gasta: <a href="'+esc(r.enlaceGastador)+'" target="_blank">'+esc(r.enlaceGastador)+'</a><br>MCP para su agente: <code>'+esc(r.mcpGastador)+'</code></div>';cargar()};
cargar();setInterval(cargar,5000);
`));
});

// ---------- página del reclamo (quien gasta) ----------

web.get('/p/:token', (req, res) => {
  const p = s.porToken(String(req.params.token));
  if (!p) return res.status(404).send('enlace no válido');
  const r = s.resumen(p);
  const quien = p.plantilla === 'mdf' ? 'Tu fondo co-op' : 'Tu reposición';
  res.type('html').send(pagina(quien, `
<div class="card"><div class="muted">${esc(p.financiador)} apartó para ti</div><h1 style="margin:.2rem 0">${esc(p.titulo)}</h1>
<div class="fila"><span><b id="saldo">$${r.saldo.toFixed(2)}</b> <span class="muted">disponibles de $${r.tope.toFixed(2)} ${esc(r.moneda)}</span></span><span class="muted">vence ${esc(r.vence.slice(0, 10))}</span></div>
<div class="muted" style="margin-top:.4rem">Puedes elegir en ${r.reglas.tiendas.length} tiendas que envían a ${esc(r.gastador.ciudad)} · ${esc(r.reglas.categorias.join(', '))}. El total incluye envío.</div></div>
<h2>¿Qué necesitas?</h2>
<form id="buscar" class="fila"><input name="q" placeholder="p. ej. wireless headphones" value="${p.plantilla === 'mdf' ? 'usb-c hub' : 'headphones'}"><button>Buscar</button></form>
<div id="opciones" class="grid" style="margin-top:1rem"></div>
<div id="cotizacion" style="margin-top:1rem"></div>
<h2>Mis compras</h2><div id="compras" class="grid"></div>
`, `
const T=${JSON.stringify(String(req.params.token))};const H={Authorization:'Bearer '+T,'content-type':'application/json'};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'$'+Number(n).toFixed(2);
async function api(m,u,b){const r=await fetch('/v1'+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});return r.json()}
document.getElementById('buscar').onsubmit=async ev=>{ev.preventDefault();const q=new FormData(ev.target).get('q');
 const box=document.getElementById('opciones');box.innerHTML='<div class="muted">Buscando sólo en tiendas permitidas…</div>';
 const r=await api('POST','/yo/opciones',{consulta:q});
 box.innerHTML=r.error?'<span class="pill no">'+esc(r.error)+'</span>':(r.opciones.map(o=>'<div class="card op">'+(o.imagen?'<img src="'+esc(o.imagen)+'">':'<img>')+'<div style="flex:1"><b>'+esc(o.nombre)+'</b><div class="muted">'+esc(o.tiendaNombre)+' · '+money(o.precio)+' + envío · <a href="'+esc(o.enlace)+'" target="_blank">ver en la tienda</a></div></div>'+(o.cabeEnSaldo?'<span class="pill ok">cabe</span>':'<span class="pill aviso">pide aprobación</span>')+'<button onclick="cotizar(\\''+o.productId+'\\')">Cotizar</button></div>').join('')||'<div class="muted">Nada dentro de las reglas. Prueba otra búsqueda.</div>')};
async function cotizar(id){const box=document.getElementById('cotizacion');box.innerHTML='<div class="muted">Cotizando con envío a tu dirección…</div>';
 const r=await api('POST','/yo/cotizar',{productId:id});if(r.error){box.innerHTML='<span class="pill no">'+esc(r.error)+'</span>';return}
 const v=r.veredicto;const cls=v.tipo==='ok'?'ok':v.tipo==='requiere_aprobacion'?'aviso':'no';const txt=v.tipo==='ok'?'Dentro de las reglas':v.tipo==='requiere_aprobacion'?'Pasa del saldo por '+money(v.diferencia)+': se pide aprobación':'Fuera de reglas: '+esc(v.razones.join('; '));
 box.innerHTML='<div class="card"><div class="fila"><b>'+esc(r.producto.nombre)+'</b><span class="pill '+cls+'">'+txt+'</span></div><table style="margin:.6rem 0"><tr><td>Artículo</td><td>'+money(r.desglose.articulos)+'</td></tr><tr><td>Envío</td><td>'+money(r.desglose.envio)+'</td></tr><tr><td>Impuestos</td><td>'+money(r.desglose.impuestos)+'</td></tr><tr><th>Total</th><th>'+money(r.desglose.total)+'</th></tr></table>'+(v.tipo!=='fuera_de_reglas'?'<button onclick="comprar(\\''+r.cotizacionId+'\\')">'+(v.tipo==='ok'?'Comprar':'Pedir aprobación')+'</button>':'')+'</div>'}
async function comprar(q){const box=document.getElementById('cotizacion');const r=await api('POST','/yo/comprar',{cotizacionId:q});
 if(r.error){box.innerHTML='<span class="pill no">'+esc(r.error)+'</span>';return}
 if(r.estado==='esperando_aprobacion'){box.innerHTML='<div class="aviso-caja">Le pedimos aprobación a quien financia. En cuanto apruebe, aquí aparece el enlace para confirmar el cargo.</div>'}
 else if(r.estado==='bloqueada'){box.innerHTML='<span class="pill no">Bloqueada: '+esc(r.razones.join('; '))+'</span>'}
 else if(r.urlAprobacion){box.innerHTML='<div class="aviso-caja">Confirma el cargo con tu passkey en la página de Reap: <a class="btn" href="'+esc(r.urlAprobacion)+'" target="_blank">Aprobar '+money(r.monto)+'</a><div class="muted">La tarjeta nunca pasa por Permiso.</div></div>'}
 cargar()}
async function cargar(){const p=await api('GET','/yo');document.getElementById('saldo').textContent=money(p.saldo);
 for(const c of p.compras.filter(c=>c.estado==='REQUIRES_ACTION'||c.estado==='PROCESSING')){await api('GET','/yo/compras/'+c.id)}
 const q=await api('GET','/yo');
 const pend=q.excepciones.filter(e=>e.estado==='pendiente').map(e=>'<div class="card fila"><span>'+esc(e.motivo)+'</span><span class="pill aviso">esperando aprobación</span></div>');
 document.getElementById('compras').innerHTML=pend.join('')+(q.compras.map(c=>'<div class="card fila"><span><a href="/p/'+T+'/compra/'+esc(c.id)+'">'+esc(c.recibo?.producto?.nombre||'Ver compra')+'</a> · '+money(c.monto)+(c.orden?' · <span class="muted">orden '+esc(c.orden)+'</span>':'')+'</span>'+(c.estado==='REQUIRES_ACTION'&&c.url?'<a class="btn" href="'+esc(c.url)+'" target="_blank">Aprobar</a>':'<span class="pill '+(c.estado==='COMPLETED'?'ok':c.estado==='FAILED'||c.estado==='EXPIRED'?'no':'aviso')+'">'+esc(c.estadoTexto||c.estado)+'</span>')+'</div>').join('')||(pend.length?'':'<div class="muted">Todavía nada.</div>'))}
cargar();setInterval(cargar,6000);
`));
});


function paginaLinea(t: ReturnType<typeof s.lineaDeTiempo>, volver: string) {
  const color = (e: string) => e === 'hecho' ? 'var(--ok)' : e === 'aviso' ? 'var(--aviso)' : 'var(--linea)';
  const pasos = t.pasos.map(x => `<li style="border-left:3px solid ${color(x.estado)};padding:.2rem 0 .9rem 1rem;list-style:none;margin-left:.4rem">
    <div class="fila"><b>${esc(x.titulo)}</b><span class="muted">${esc(new Date(x.ts).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Mexico_City' }))}</span></div>
    ${x.detalle ? `<div class="muted" style="word-break:break-all">${esc(x.detalle)}</div>` : ''}</li>`).join('');
  return pagina('Compra', `<a href="${esc(volver)}" class="muted">← volver</a>
<div class="card" style="margin-top:.6rem"><div class="muted">${esc(t.permiso.financiador)} · ${esc(t.permiso.titulo)}</div>
<div class="fila"><h1 style="margin:.2rem 0">$${t.compra.monto.toFixed(2)} ${esc(t.compra.moneda)}</h1><span class="pill ${t.compra.estado === 'COMPLETED' ? 'ok' : ['FAILED', 'EXPIRED'].includes(t.compra.estado) ? 'no' : 'aviso'}">${esc(t.compra.estadoTexto)}</span></div></div>
<h2>Qué pasó</h2><ol class="card" style="padding:1rem">${pasos}</ol>`, 'setTimeout(()=>location.reload(),8000)');
}

web.get('/consola/:token/compra/:permiso/:compra', (req, res) => {
  if (!igual(String(req.params.token), config.funderToken())) return res.status(404).send('no encontrado');
  try { res.type('html').send(paginaLinea(s.lineaDeTiempo(String(req.params.permiso), String(req.params.compra)), `/consola/${req.params.token}`)); }
  catch { res.status(404).send('no encontrado'); }
});

web.get('/p/:token/compra/:compra', async (req, res) => {
  const p = s.porToken(String(req.params.token));
  if (!p) return res.status(404).send('enlace no válido');
  try { await s.estadoCompra(p, String(req.params.compra)).catch(() => null); res.type('html').send(paginaLinea(s.lineaDeTiempo(p.id, String(req.params.compra)), `/p/${req.params.token}`)); }
  catch { res.status(404).send('no encontrado'); }
});

// ---------- página de demo: tres columnas, una historia ----------

web.get('/demo/:token', (req, res) => {
  if (!igual(String(req.params.token), config.funderToken())) return res.status(404).send('no encontrado');
  res.type('html').send(pagina('Demo', `
<style>.tres{display:grid;grid-template-columns:1fr 1.1fr 1fr;gap:1rem;align-items:start}@media(max-width:1000px){.tres{grid-template-columns:1fr}}
.chat{display:flex;flex-direction:column;gap:.5rem;max-height:520px;overflow:auto;padding:.5rem;background:#fafaf8;border-radius:10px}
.b{max-width:85%;padding:.5rem .7rem;border-radius:12px;font-size:14px;white-space:pre-wrap}.yo{align-self:flex-end;background:#dcf5e3}.el{align-self:flex-start;background:#fff;border:1px solid var(--linea)}
.feed{display:flex;flex-direction:column;gap:.4rem;max-height:420px;overflow:auto}.ev{border-left:3px solid var(--linea);padding:.2rem .6rem;font-size:13px}.ev.ok{border-color:var(--ok)}.ev.aviso{border-color:var(--aviso)}.ev.no{border-color:var(--no)}
.k{display:flex;justify-content:space-between;font-size:14px;padding:.25rem 0;border-bottom:1px solid var(--linea)}</style>
<div class="fila"><h1>Demo: una historia completa</h1><div style="display:flex;gap:.5rem;flex-wrap:wrap">
<button onclick="nuevo('reclamo')">Nuevo reclamo (aseguradora)</button><button class="sec" onclick="nuevo('reclamo_estricto')">Reclamo que pregunta</button><button class="sec" onclick="nuevo('fondo')">Nuevo fondo (marca)</button><button class="sec" onclick="nuevo('fondo_kwal')">Fondo que paga solo (Kwal)</button></div></div>
<div class="tres">
 <div class="card"><h2 style="margin-top:0">Quien paga</h2><div id="regla" class="muted">Crea un permiso para empezar.</div><h2>Decisiones</h2><div id="feed" class="feed muted">—</div></div>
 <div class="card"><h2 style="margin-top:0">La persona (su asistente)</h2><div id="chat" class="chat"></div>
  <form id="f" class="fila" style="margin-top:.6rem"><input name="t" placeholder="Escribe como el cliente…" autocomplete="off"><button>Enviar</button></form>
  <div style="margin-top:.6rem;display:flex;gap:.5rem;flex-wrap:wrap"><button class="sec" onclick="historia()">Correr la historia sola</button><button class="sec" onclick="sinManos()">Compra sin manos (Kwal)</button><button class="sec" onclick="fuera()">Tienda fuera de la regla</button><span class="muted" id="paso"></span></div></div>
 <div class="card"><h2 style="margin-top:0">Dinero y prueba</h2><div id="dinero"></div><h2>Compras</h2><div id="compras" class="muted">—</div><h2>En la cadena</h2><div id="cadena" class="muted">—</div></div>
</div>`, `
const T=${JSON.stringify(String(req.params.token))};const H={Authorization:'Bearer '+T,'content-type':'application/json'};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const money=n=>'$'+Number(n).toFixed(2);
let P=null;async function api(m,u,b){const r=await fetch('/v1'+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});return r.json()}
function burbuja(t,yo){const c=document.getElementById('chat');const d=document.createElement('div');d.className='b '+(yo?'yo':'el');d.textContent=t;c.appendChild(d);c.scrollTop=c.scrollHeight}
async function nuevo(e){const r=await api('POST','/escenarios/'+e);if(r.error){alert(r.error);return}P=r;document.getElementById('chat').innerHTML='';burbuja('Nuevo permiso: '+r.titulo+'. Enlace de la persona: '+r.enlaceGastador,false);pintar()}
async function pintar(){if(!P)return;const p=await api('GET','/permisos/'+P.id);P={...P,...p};
 const pol=(p.reglas.politica&&p.reglas.politica.modo==='preguntar')?'Política: preguntar a una persona en cada excepción.':'Política: aprobar sola hasta 20% arriba si es la opción más barata; escalar lo demás.';
 document.getElementById('regla').innerHTML='<b>'+esc(p.financiador)+'</b> apartó <b>'+money(p.tope)+'</b> para <b>'+esc(p.gastador.nombre)+'</b><div class="muted">'+esc(p.titulo)+' · '+esc(p.reglas.categorias.join(', '))+' · '+p.reglas.tiendas.length+' tiendas · vence '+esc(p.vence.slice(0,10))+'</div><div class="muted" style="margin-top:.3rem">'+pol+'</div>';
 const a=await api('GET','/auditoria');const ev=a.eventos.filter(e=>e.permiso_id===p.id&&['opciones','cotizacion','excepcion','decision_politica','excepcion_aprobada','excepcion_rechazada','bloqueada','checkout','compra_estado','onchain_liberado','permiso_cerrado'].includes(e.tipo)).reverse();
 const txt=e=>{const d=e.detalle;switch(e.tipo){case'opciones':return['Buscó "'+d.consulta+'" en '+d.tiendas+' tiendas permitidas: '+d.resultados+' opciones','ok'];case'cotizacion':return['Cotizó '+d.producto+' por '+money(d.total)+': '+(d.veredicto==='ok'?'dentro de la regla':d.veredicto==='requiere_aprobacion'?'pasa del saldo':'fuera de reglas'),d.veredicto==='ok'?'ok':d.veredicto==='requiere_aprobacion'?'aviso':'no'];case'excepcion':return['Excepción: pasa del saldo por '+money(d.diferencia),'aviso'];case'decision_politica':return['La política decidió: '+d.decision+'. '+d.razon,d.decision==='aprobar'?'ok':d.decision==='rechazar'?'no':'aviso'];case'excepcion_aprobada':return['Aprobada'+(d.nota?' · '+d.nota:''),'ok'];case'excepcion_rechazada':return['Rechazada'+(d.nota?' · '+d.nota:''),'no'];case'bloqueada':return['Bloqueada: '+(d.razones||[]).join('; '),'no'];case'checkout':return['Pago abierto en Reap por '+money(d.monto),'ok'];case'compra_estado':return['Reap: '+d.estado+(d.orden?' · orden '+d.orden:''),d.estado==='COMPLETED'?'ok':'aviso'];case'onchain_liberado':return['El contrato liberó '+(d.monto/100).toFixed(4)+' USDC a la bóveda','ok'];case'permiso_cerrado':return['Cerrado: sobrante '+money(d.sobrante)+' de vuelta','ok'];default:return[e.tipo,'']}};
 document.getElementById('feed').innerHTML=ev.length?ev.map(e=>{const[t,c]=txt(e);return'<div class="ev '+c+'"><span class="muted">'+esc(e.ts.slice(11,19))+'</span> '+esc(t)+'</div>'}).join(''):'<span class="muted">Todavía nada.</span>';
 document.getElementById('dinero').innerHTML='<div class="k"><span>Apartado</span><b>'+money(p.tope)+'</b></div><div class="k"><span>Gastado</span><b>'+money(p.gastado)+'</b></div><div class="k"><span>Saldo</span><b>'+money(p.saldo)+'</b></div>'+(p.estado==='cerrado'?'<div class="k"><span>Sobrante devuelto</span><b>'+money(p.sobrante)+'</b></div>':'<div style="margin-top:.5rem"><button class="sec" onclick="cerrar()">Cerrar y devolver sobrante</button></div>');
 document.getElementById('compras').innerHTML=p.compras.length?p.compras.map(c=>'<div class="k"><span>'+esc(c.recibo?.producto?.nombre||'Compra')+'</span><span><span class="pill '+(c.estado==='COMPLETED'?'ok':'aviso')+'">'+esc(c.estadoTexto)+'</span> '+(c.estado==='REQUIRES_ACTION'&&c.url?'<a class="btn" style="padding:.2rem .5rem" target="_blank" href="'+esc(c.url)+'">Aprobar</a>':'')+' <a href="/consola/'+T+'/compra/'+p.id+'/'+c.id+'">ver</a></span></div>').join(''):'<span class="muted">Todavía nada.</span>';
 const oc=p.onchain||{};document.getElementById('cadena').innerHTML=oc.contrato?'<div class="k"><span>USDC bloqueado</span><b>'+oc.usdcBloqueado+'</b></div><div class="k"><span>Creación</span><a target="_blank" href="https://explorer-sepolia.inkonchain.com/tx/'+esc(oc.txCreacion)+'">tx</a></div>'+p.compras.filter(c=>c.tx).map(c=>'<div class="k"><span>Recibo</span><a target="_blank" href="https://explorer-sepolia.inkonchain.com/tx/'+esc(c.tx)+'">tx</a></div>').join('')+(oc.txCierre?'<div class="k"><span>Cierre</span><a target="_blank" href="https://explorer-sepolia.inkonchain.com/tx/'+esc(oc.txCierre)+'">tx</a></div>':'')+'<div class="muted">Contrato <a target="_blank" href="https://explorer-sepolia.inkonchain.com/address/'+esc(oc.contrato)+'">'+esc(oc.contrato.slice(0,10))+'…</a> · escala '+esc(oc.escalaTexto||oc.escala||'')+'</div>':'<span class="muted">Sin contrato (apagado).</span>';
}
async function decir(t){if(!P)return;burbuja(t,true);document.getElementById('paso').textContent='pensando…';const r=await api('POST','/demo/charla',{permisoId:P.id,texto:t});burbuja(r.respuesta||r.error,false);document.getElementById('paso').textContent='';pintar()}
document.getElementById('f').onsubmit=ev=>{ev.preventDefault();const i=ev.target.t;const t=i.value.trim();i.value='';if(t)decir(t)};
async function historia(){if(!P){await nuevo('reclamo')}await decir('Hola, me robaron mis audífonos. ¿Qué me recomiendas de Linsoul?');await decir('Cotízame el más barato que tenga buen sonido y cómpralo');}
async function cerrar(){if(confirm('¿Cerrar y devolver el sobrante?')){await api('POST','/permisos/'+P.id+'/cerrar');pintar()}}
async function fuera(){if(!P){await nuevo('reclamo')}burbuja('Mejor cómprame café de deathwishcoffee.com con mi reposición.',true);document.getElementById('paso').textContent='cotizando en una tienda que la regla no permite…';const r=await api('POST','/demo/probar-tienda',{permisoId:P.id,tienda:'deathwishcoffee.com'});document.getElementById('paso').textContent='';burbuja(r.error?('No se pudo: '+r.error):(r.veredicto&&r.veredicto.tipo==='fuera_de_reglas'?('Bloqueado por la regla: '+r.veredicto.razones.join('; ')+'. No se compró nada.'):JSON.stringify(r.veredicto)),false);pintar()}
async function sinManos(){if(!P){await nuevo('fondo_kwal')}burbuja('Compra lo más barato que haya en keycaps dentro de mi fondo, sin preguntarme.',true);document.getElementById('paso').textContent='la bóveda está pagando… (puede tardar un par de minutos)';const r=await api('POST','/demo/sin-manos',{permisoId:P.id,consulta:'keycaps'});document.getElementById('paso').textContent='';burbuja(r.error?('No se pudo: '+r.error):(r.estado==='completada'?('Listo, sin tocar un teléfono: '+r.producto+' por '+money(r.monto)+' '+r.moneda+'. Orden '+(r.orden||'')+'. El contrato liberó el monto exacto a la bóveda y la bóveda pagó, en '+r.segundos+' s.'):(r.mensaje||r.estado)),false);pintar()}
setInterval(()=>P&&pintar(),6000);
`));
});

// ---------- panel de la marca: la cartera completa de distribuidores ----------

web.get('/marca/:token', (req, res) => {
  if (!igual(String(req.params.token), config.funderToken())) return res.status(404).send('no encontrado');
  res.type('html').send(pagina('Marca', `
<style>.kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.8rem}.kp .card .v{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.socio{display:grid;grid-template-columns:1.6fr 1fr 2fr .7fr .7fr 1.2fr;gap:.8rem;align-items:center;padding:.6rem .2rem;border-bottom:1px solid var(--linea);font-size:14px}
.socio.cab{font-size:12px;color:var(--suave)}.real{background:#f3faf5}.chip{font-size:11px;border-radius:999px;padding:.05rem .45rem;border:1px solid var(--linea);color:var(--suave)}
.chip.vivo{border-color:var(--ok);color:var(--ok)}</style>
<div class="fila"><div><div class="muted">Marca Demo · Fondos co-op Q4</div><h1 style="margin:.2rem 0">Cartera de distribuidores</h1></div>
<div style="display:flex;gap:.5rem;flex-wrap:wrap"><button onclick="lanzar()">Fondear distribuidores reales</button><button onclick="correr()">Todos compran a la vez</button><button class="sec" onclick="cerrarQ()">Cerrar trimestre</button></div></div>
<div id="aviso" class="muted" style="margin:.4rem 0 1rem"></div>
<div class="kp" id="kpis"></div>
<h2>Distribuidores</h2>
<div class="card"><div class="socio cab"><span>Distribuidor</span><span>Fondo</span><span>Uso</span><span>Compras</span><span>Excep.</span><span>Prueba</span></div><div id="lista"></div></div>
<p class="muted">Los distribuidores marcados <span class="chip vivo">en vivo</span> pagan desde su propia bóveda Kwal con USDC liberado por el contrato en Ink Sepolia, sin que nadie apruebe en un teléfono. Los marcados <span class="chip">simulado</span> enseñan cómo se ve la cartera a escala.</p>
`, `
const T=${JSON.stringify(String(req.params.token))};const H={Authorization:'Bearer '+T,'content-type':'application/json'};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const money=n=>'$'+Number(n).toLocaleString('en-US',{maximumFractionDigits:2});
async function api(m,u,b){const r=await fetch('/v1'+u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});return r.json()}
const X='https://explorer-sepolia.inkonchain.com/tx/';
async function pintar(){const d=await api('GET','/marca/panel');const k=d.kpis;
 document.getElementById('kpis').innerHTML=[['Distribuidores',k.distribuidores],['Fondos asignados',money(k.asignado)],['Utilización',k.utilizacion+'%'],['Compras',k.compras],['Sin intervención humana',k.sinPersona+'%'],['Bloqueadas por regla',k.bloqueos]].map(([l,v])=>'<div class="card"><div class="v">'+v+'</div><div class="muted">'+l+'</div></div>').join('');
 const fila=(x,real)=>{const pct=Math.min(100,Math.round(100*x.gastado/Math.max(1,x.tope)));const prueba=real?((x.txCreacion?'<a target="_blank" href="'+X+esc(x.txCreacion)+'">fondeo</a> ':'')+x.ultimas.filter(u=>u.tx).map(u=>'<a target="_blank" href="'+X+esc(u.tx)+'">compra</a>').join(' ')+(x.txCierre?' <a target="_blank" href="'+X+esc(x.txCierre)+'">cierre</a>':'')):'—';
  return '<div class="socio'+(real?' real':'')+'"><span><b>'+esc(x.socio)+'</b> <span class="chip'+(real?' vivo':'')+'">'+(real?'en vivo':'simulado')+'</span>'+(real&&x.ultimas[0]?'<div class="muted">'+esc(x.ultimas[0].producto?.nombre||x.ultimas[0].producto||'')+' · '+esc(x.ultimas[0].estado)+'</div>':'')+(real&&x.estado==='cerrado'?'<div class="muted">cerrado · sobrante '+money(x.sobrante)+' devuelto</div>':'')+'</span><span>'+money(x.tope)+'</span><span><div class="barra"><i style="width:'+pct+'%"></i></div><span class="muted">'+money(x.gastado)+' · '+pct+'%</span></span><span>'+x.compras+'</span><span>'+x.excepciones+'</span><span>'+prueba+'</span></div>'};
 document.getElementById('lista').innerHTML=d.reales.map(x=>fila(x,true)).join('')+d.simulados.map(x=>fila(x,false)).join('');}
async function lanzar(){aviso('Fondeando: el contrato bloquea el USDC de cada distribuidor…');const r=await api('POST','/marca/lanzar',{tope:10});aviso(r.error?r.error:(r.creados.length?'Fondeados: '+r.creados.map(c=>c.socio).join(', '):'Ya estaban fondeados.'));pintar()}
async function correr(){aviso('Cada distribuidor compra con su bóveda, todos a la vez. Nadie aprueba nada: la regla ya está autorizada…');const r=await api('POST','/marca/correr',{consulta:'keycaps'});aviso(r.error?r.error:('Listo en '+r.segundos+' s: '+r.resultados.map(x=>x.socio+': '+(x.estado==='completada'?('compró '+x.producto+' por '+money(x.monto)):(x.mensaje||x.estado))).join(' · ')));pintar()}
async function cerrarQ(){if(!confirm('¿Cerrar el trimestre y devolver todo lo no gastado a la marca?'))return;aviso('Cerrando: el contrato devuelve los sobrantes…');const r=await api('POST','/marca/cerrar-trimestre');aviso(r.error?r.error:('Trimestre cerrado. Devuelto: '+r.cerrados.map(c=>c.socio+' '+money(c.sobrante)).join(', ')));pintar()}
function aviso(t){document.getElementById('aviso').textContent=t}
pintar();setInterval(pintar,8000);
`));
});
