/* ============================================================
   SOSER · App del Técnico — v1
   ------------------------------------------------------------
   Tercer pilar. El técnico elige su nombre (de la lista que el
   admin gestiona), ve los casos que le derivaron (pendientes),
   los cierra con materiales + verificadores + GPS. El cierre
   escribe SOLUCIONADO en la hoja original (se refleja en todas
   las apps) y copia el caso a la hoja del técnico con materiales
   expandidos en columnas. Sin mapa. Requiere Apps Script v5.
   ============================================================ */
'use strict';

const COL = { RBD: 0, NOM: 1, DIR: 2, COM: 3, SUP: 4, INST: 5, TEC: 6 };
const LOGO_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F49A0F"/><stop offset="0.5" stop-color="#E8A30C"/><stop offset="1" stop-color="#7DB61C"/></linearGradient></defs><path d="M50 12 C30 12 20 30 28 48 C34 62 50 64 50 64 C50 64 66 62 72 48 C80 30 70 12 50 12 Z" fill="url(#sg)"/><path d="M50 20 C44 30 56 40 50 52 C46 44 54 34 50 20 Z" fill="#2E7D32" opacity="0.85"/></svg>`;
const LS_CFG = 'soser_tec_cfg';
const DEFAULT_EXEC = 'https://script.google.com/macros/s/AKfycbze-p4PtiC5u41vKnwpTFyTiooXoGGGMaPKtvPnyUYn_cIiNCaAUJN3lQdOwV6MvqW0/exec';
const CFG_PIN = '123456789';
const POLL_MS = 45000;

let CFG = loadCfg();
let ALL = [];               // casos derivados a este técnico
let TECNICOS = [];          // lista de técnicos (para elegir nombre)
let PRODUCTOS = [];         // catálogo
let CFG_TEC = {};           // config del técnico (columnas visibles, etc.)
let pollTimer = null;
let currentView = 'home';
let lastGps = null;
let homeFetchTried = false;         // {lat, lon, acc, ts} — capturado en segundo plano

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const content = $('#content'), navwrap = $('#navwrap'), overlays = $('#overlays');
const btnBack = $('#btnBack'), btnNext = $('#btnNext');
$('#logoSlot').innerHTML = LOGO_SVG;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(m, ms = 2200) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
function norm(s) { return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function loadCfg() { try { const c = JSON.parse(localStorage.getItem(LS_CFG)); return c || { sheetUrl: DEFAULT_EXEC }; } catch { return { sheetUrl: DEFAULT_EXEC }; } }
function saveCfg(c) { localStorage.setItem(LS_CFG, JSON.stringify(c)); CFG = c; }
function showNav(show) { navwrap.classList.toggle('hidden', !show); }
function tsOf(r) { const t = Date.parse(r.timestamp); if (!isNaN(t)) return t; return parseFechaCL(r.fecha) || 0; }
function parseFechaCL(f) { if (!f) return 0; const m = String(f).match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (!m) return 0; return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime(); }

function esEmergencia(r) { return norm(r.categoria) === 'emergencia'; }
function estadoDe(r) {
  const v = (r.visado || '').toString().trim().toLowerCase();
  const d = (r.derivadoA || '').toString().trim();
  if (v.startsWith('eliminado')) return { k: 'pend', t: 'Eliminado', del: true };
  if (v.includes('solucion') || v.includes('final')) return { k: 'fin', t: 'Solucionado' };
  if (d) return { k: 'pend', t: 'Derivado' };       // derivado a alguien, aún por resolver
  if (v.includes('visado')) return { k: 'pend', t: 'Visado' };
  return { k: 'pend', t: 'No visado' };
}
function isBorrado(r) { return (r.visado || '').toString().toLowerCase().startsWith('eliminado'); }
function activos(list) { return list.filter(r => !isBorrado(r)); }

/* Drive embebible */
function driveIdFrom(url) {
  if (!url) return '';
  let m = String(url).match(/\/file\/d\/([-\w]{20,})/); if (m) return m[1];
  m = String(url).match(/[?&]id=([-\w]{20,})/); if (m) return m[1];
  m = String(url).match(/googleusercontent\.com\/d\/([-\w]{20,})/); if (m) return m[1];
  return '';
}
function driveImgSources(id) { return [`https://lh3.googleusercontent.com/d/${id}=w1600`, `https://drive.google.com/thumbnail?id=${id}&sz=w1600`]; }
function driveVideoPreview(id) { return `https://drive.google.com/file/d/${id}/preview`; }
function driveOpenUrl(id) { return `https://drive.google.com/file/d/${id}/view`; }
function driveThumb(id) { return `https://drive.google.com/thumbnail?id=${id}&sz=w200`; }
function verifList(raw) {
  const out = [];
  if (!raw) return out;
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    const um = line.match(/(https?:\/\/[^\s]+)/); const url = um ? um[1] : '';
    if (!url) continue;
    const type = /(^|\b)video\b/i.test(line) || /\.webm/i.test(line) ? 'video' : 'photo';
    const nm = (line.split('->')[0].split(':').slice(1).join(':').trim()) || line.split(':')[0].trim();
    out.push({ name: nm, url, driveId: driveIdFrom(url), type });
  }
  return out;
}

/* índice de establecimientos */
const ESTS = (() => {
  const seen = new Set(), out = [];
  for (const r of BBDD) {
    const key = String(r[COL.RBD]) + '|' + norm(r[COL.NOM]);
    if (seen.has(key)) continue; seen.add(key);
    out.push({ rbd: String(r[COL.RBD]), nom: r[COL.NOM], dir: r[COL.DIR], com: r[COL.COM], tec: r[COL.TEC], inst: r[COL.INST] });
  }
  return out;
})();
function estByRbd(rbd) { return ESTS.find(e => e.rbd === String(rbd)); }

/* ===================== GPS (temprano y en segundo plano) ===================== */
let gpsWatchId = null;
function startGpsWatch() {
  if (!('geolocation' in navigator) || gpsWatchId !== null) return;
  try {
    gpsWatchId = navigator.geolocation.watchPosition(
      pos => { lastGps = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, ts: Date.now() }; updateGpsPills(); },
      err => { updateGpsPills(); },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
    );
  } catch (e) {}
}
function gpsFresh() { return lastGps && (Date.now() - lastGps.ts < 120000); }
function gpsString() { return lastGps ? `${lastGps.lat.toFixed(6)},${lastGps.lon.toFixed(6)} (±${Math.round(lastGps.acc)}m)` : ''; }
function updateGpsPills() {
  $$('.gps-pill').forEach(p => {
    const ok = gpsFresh();
    p.className = 'gps-pill ' + (ok ? 'ok' : (lastGps ? 'wait' : 'err'));
    const txt = p.querySelector('.gtxt');
    if (txt) txt.textContent = ok ? ('Ubicación lista · ±' + Math.round(lastGps.acc) + 'm') : (lastGps ? 'Actualizando ubicación…' : 'Activa el GPS para poder cerrar casos');
  });
}

/* ===================== RED ===================== */
// fetch con timeout: si el servidor no responde en N segundos, aborta (evita cuelgue eterno)
async function fetchWithTimeout(url, ms) {
  ms = ms || 20000;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}
async function fetchMine() {
  if (!CFG.sheetUrl || !CFG.tecnico) return null;
  try {
    const res = await fetchWithTimeout(CFG.sheetUrl + '?tecnico=' + encodeURIComponent(CFG.tecnico) + '&t=' + Date.now(), 20000);
    const d = await res.json();
    if (d && d.ok) {
      if (Array.isArray(d.productos)) PRODUCTOS = d.productos;
      if (d.configTecnico) CFG_TEC = d.configTecnico;
      return Array.isArray(d.reportes) ? d.reportes : [];
    }
  } catch (e) {}
  return null;
}
async function fetchTecnicos() {
  if (!CFG.sheetUrl) return null;
  try { const r = await fetch(CFG.sheetUrl + '?tecnicos=1&t=' + Date.now()); const d = await r.json(); if (d && d.ok) return d.tecnicos || []; } catch (e) {}
  return null;
}
async function fetchProductos() {
  if (!CFG.sheetUrl) return null;
  try { const r = await fetch(CFG.sheetUrl + '?productos=1&t=' + Date.now()); const d = await r.json(); if (d && d.ok) { PRODUCTOS = d.productos || []; if (d.configTecnico) CFG_TEC = d.configTecnico; return PRODUCTOS; } } catch (e) {}
  return null;
}
async function postAction(payload) {
  try { const res = await fetch(CFG.sheetUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }); return await res.json().catch(() => ({ ok: true })); }
  catch (e) { return { ok: false, error: String(e) }; }
}
async function uploadFile(fileName, mime, base64, tecnico) {
  return postAction({ accion: 'subirArchivoTecnico', fileName, mime, data: base64 });
}

let refreshInFlight = false;
let lastFetchOk = true;
async function refreshData(silent) {
  if (refreshInFlight) return false;
  refreshInFlight = true;
  try {
    const data = await fetchMine();
    if (!data) { lastFetchOk = false; if (!silent) toast('No se pudo conectar. Reintentando en segundo plano…', 2600); return false; }
    ALL = data; lastFetchOk = true; return true;
  } finally { refreshInFlight = false; }
}
function startPolling() { stopPolling(); pollTimer = setInterval(async () => { const ok = await refreshData(true); if (ok) rerenderCurrent(); }, POLL_MS); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function rerenderCurrent() {
  if (currentView === 'home') updateHomeNumbers();
  else if (currentView === 'generales') renderGenerales(true);
  else if (currentView === 'historico') renderHistorico(true);
}

/* ===================== HOME ===================== */
function renderHome() {
  currentView = 'home';
  $('#btnHome').classList.add('hidden'); showNav(false);
  const cfgOk = !!(CFG.sheetUrl && CFG.tecnico);
  $('#techTag').classList.toggle('hidden', !CFG.tecnico);
  if (CFG.tecnico) $('#techTag').textContent = '🔧 ' + CFG.tecnico;

  const act = activos(ALL);
  const pend = act.filter(r => estadoDe(r).k === 'pend').length;
  const hist = act.filter(r => estadoDe(r).k === 'fin').length;

  content.innerHTML = `<div class="screen"><div style="flex:1;overflow-y:auto">
    <div class="hero"><div class="mark">${LOGO_SVG}</div><h1>${cfgOk ? 'Hola, ' + esc((CFG.tecnico || '').split(' ')[0]) : 'App del Técnico'}</h1>
      <p>${cfgOk ? 'Tus casos asignados · SOSER' : 'Configura tu nombre para comenzar'}</p></div>
    <div class="kpi-list">
      <button class="kpi-btn pend" id="kPend"><div class="kic">📋</div>
        <div class="kmain"><div class="kname">Generales</div><div class="ksub">Casos pendientes por resolver</div></div>
        <div class="knum" id="nPend">${pend}</div></button>
      <button class="kpi-btn hist" id="kHist"><div class="kic">🗂️</div>
        <div class="kmain"><div class="kname">Casos históricos</div><div class="ksub">Trabajos ya cerrados</div></div>
        <div class="knum" id="nHist">${hist}</div></button>
      <button class="kpi-btn buscar" id="kBuscar"><div class="kic">🔎</div>
        <div class="kmain"><div class="kname">Buscar establecimiento</div><div class="ksub">Ver casos por colegio</div></div>
        <div class="knum" style="font-size:18px">›</div></button>
    </div>
    <div class="cfg-fab" id="aCfg" title="Configuración">⚙️</div>
    ${cfgOk ? '' : '<div class="cfg-warn">Toca ⚙️ y <b>elige tu nombre</b> para ver tus casos.</div>'}
    ${cfgOk && !lastFetchOk ? '<div class="cfg-warn" style="background:rgba(206,66,87,.08);border-color:rgba(206,66,87,.35);color:var(--red-d)">Sin conexión con el servidor. <b id="btnRetry" style="text-decoration:underline;cursor:pointer">Reintentar</b></div>' : ''}
    <p class="note" style="text-align:center;margin-bottom:16px">${cfgOk ? (lastFetchOk ? 'Actualizado: ' + new Date().toLocaleTimeString('es-CL') : 'Última conexión fallida') : ''}</p>
  </div></div>`;

  $('#kPend').onclick = () => cfgOk ? renderGenerales() : needCfg();
  $('#kHist').onclick = () => cfgOk ? renderHistorico() : needCfg();
  $('#kBuscar').onclick = () => cfgOk ? renderBuscar() : needCfg();
  $('#aCfg').onclick = () => askPin(renderConfig);
  const retry = $('#btnRetry'); if (retry) retry.onclick = async () => { retry.textContent = 'Reintentando…'; homeFetchTried = false; const ok = await refreshData(false); renderHome(); if (ok) toast('Conectado ✓'); };

  // cargar datos solo UNA vez; si falla no reintenta en bucle (evita el reinicio infinito)
  if (cfgOk && !ALL.length && !homeFetchTried) {
    homeFetchTried = true;
    refreshData(false).then(ok => { if (ok && currentView === 'home') renderHome(); });
  }
}
function needCfg() { toast('Primero elige tu nombre en ⚙️'); askPin(renderConfig); }
function bumpNum(id, val) { const el = $('#' + id); if (!el) return; if (el.textContent !== String(val)) { el.textContent = val; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); } }
function updateHomeNumbers() {
  const act = activos(ALL);
  bumpNum('nPend', act.filter(r => estadoDe(r).k === 'pend').length);
  bumpNum('nHist', act.filter(r => estadoDe(r).k === 'fin').length);
}

/* ===================== PIN + CONFIG ===================== */
function askPin(onOk) {
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; let entered = '';
  content.innerHTML = `<div class="screen"><div style="flex:1;display:flex;align-items:center;justify-content:center">
    <div class="card" style="max-width:340px;width:100%">
      <div class="eyebrow"><b>Configuración</b></div>
      <h2 class="q" style="text-align:center;margin-bottom:4px">Ingresa la clave</h2>
      <div class="pin-dots" id="pinDots">${'<i></i>'.repeat(9)}</div>
      <div class="pin-grid" id="pinGrid">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="pin-key" data-k="${n}">${n}</button>`).join('')}
        <button class="pin-key" data-k="del">⌫</button><button class="pin-key" data-k="0">0</button><button class="pin-key" data-k="ok" style="background:var(--grad-green);color:#fff">✓</button>
      </div>
    </div></div></div>`;
  const dots = () => $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < entered.length));
  const check = () => { if (entered === CFG_PIN) onOk(); else { toast('Clave incorrecta'); entered = ''; dots(); } };
  $$('#pinGrid .pin-key').forEach(b => b.onclick = () => { const k = b.dataset.k; if (k === 'del') entered = entered.slice(0, -1); else if (k === 'ok') return check(); else if (entered.length < 9) entered += k; dots(); if (entered.length === 9) check(); });
}

function renderConfig() {
  showNav(true); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  content.innerHTML = `<div class="screen"><div style="flex:1;overflow-y:auto"><div class="card">
    <div class="eyebrow"><b>Configuración</b></div><h2 class="q">Tu cuenta</h2>
    <div class="banner">Elige tu nombre de la lista. Solo aparecen los técnicos que el administrador registró.</div>
    <div class="field-block"><label class="fld">Elija su nombre</label>
      <div class="search-wrap" id="tecSearchWrap">
        <span class="ic-lead">🔧</span>
        <input type="text" id="tecQ" placeholder="Escribe o elige tu nombre…" autocomplete="off" value="${esc(CFG.tecnico || '')}">
        <button class="clearbtn hidden" id="tecClr">✕</button>
        <div class="suggest hidden" id="tecSug"></div>
      </div>
    </div>
    <div class="field-block"><label class="fld">URL del Apps Script (/exec)</label>
      <input type="url" id="cfgUrl" placeholder="https://script.google.com/.../exec" value="${esc(CFG.sheetUrl || '')}">
      <p class="note">Ya viene configurada. Cámbiala solo si el administrador te da una nueva.</p>
    </div>
  </div></div></div>`;
  btnBack.onclick = renderHome; btnNext.textContent = 'Guardar'; btnNext.disabled = false; btnNext.className = 'btn green';
  btnNext.onclick = () => {
    const url = $('#cfgUrl').value.trim();
    const tec = $('#tecQ').value.trim();
    if (!tec) { toast('Elige tu nombre'); return; }
    if (!TECNICOS.some(t => norm(t) === norm(tec))) { toast('Ese nombre no está en la lista de técnicos'); return; }
    const nombreReal = TECNICOS.find(t => norm(t) === norm(tec));
    saveCfg({ sheetUrl: url, tecnico: nombreReal });
    toast('Guardando y creando tu hoja…');
    $('#btnNext').innerHTML = '<span class="spinner"></span>';
    // registrar: crea la hoja Tec-Nombre y copia los casos derivados a él
    postAction({ accion: 'registrarTecnico', tecnico: nombreReal }).then(() => {
      homeFetchTried = false;
      refreshData(false).then(() => { renderHome(); startPolling(); startGpsWatch(); });
    });
  };
  bindTecSearch();
}
async function bindTecSearch() {
  if (!TECNICOS.length) { const t = await fetchTecnicos(); if (t) TECNICOS = t; }
  const inp = $('#tecQ'), sug = $('#tecSug'), clr = $('#tecClr');
  if (!inp) return;
  const paint = () => {
    const v = norm(inp.value.trim()); clr.classList.toggle('hidden', !inp.value);
    const list = v ? TECNICOS.filter(t => norm(t).includes(v)) : TECNICOS;
    if (!list.length) { sug.innerHTML = `<div class="sopt"><div class="stxt">Sin técnicos. El admin debe agregarte.</div></div>`; sug.classList.remove('hidden'); return; }
    sug.innerHTML = list.map(t => `<div class="sopt" data-t="${esc(t)}"><div class="stxt">🔧 ${esc(t)}</div></div>`).join('');
    sug.classList.remove('hidden');
    $$('#tecSug .sopt[data-t]').forEach(d => d.onclick = () => { inp.value = d.dataset.t; sug.classList.add('hidden'); clr.classList.remove('hidden'); });
  };
  inp.addEventListener('focus', paint);
  inp.addEventListener('input', paint);
  clr.onclick = () => { inp.value = ''; sug.classList.add('hidden'); clr.classList.add('hidden'); inp.focus(); };
}

/* ===================== LISTAS ===================== */
function caseCardHTML(r) {
  const st = estadoDe(r); const em = esEmergencia(r);
  const est = r.establecimiento || (estByRbd(r.rbd) || {}).nom || '—';
  const nver = verifList(r.verificadores).length + verifList(r.verificadoresTecnico).length;
  const stCls = (em && st.k !== 'fin') ? 'em' : (st.k === 'fin' ? 'fin' : 'pend');
  const fechaEstado = st.k === 'fin' && r.fechaSolucionado ? `<span>✓ ${esc(r.fechaSolucionado)}</span>` : '';
  return `<div class="case ${em ? 'em' : ''}" data-id="${esc(r.id)}" data-enc="${esc(r.encargado)}">
    <div class="cid">${esc(r.id)}</div>
    <div class="cbody">
      <div class="ctitle">${esc(est)} · RBD ${esc(r.rbd)}</div>
      <div class="cdesc">${esc(r.descripcion || '')}</div>
      <div class="cmeta"><span>${em ? '🚨 ' : ''}${esc(r.categoria || '')}</span><span>📅 ${esc(r.fecha || '')}</span><span class="cstate ${stCls}">${st.t}</span>${fechaEstado}${r.derivadoA ? `<span>🔧 ${esc(r.derivadoA)}</span>` : ''}</div>
    </div>
    <div class="cside">${nver ? `<button class="cverif" data-verif="1"><span class="vic">📎</span>${nver}</button>` : ''}</div>
  </div>`;
}
function bindCaseCards(box, list) {
  $$('.case', box).forEach(c => {
    const r = list.find(x => String(x.id) === c.dataset.id && x.encargado === c.dataset.enc);
    c.onclick = e => { if (e.target.closest('.cverif')) { openViewer([...verifList(r.verificadores), ...verifList(r.verificadoresTecnico)]); return; } openCase(r); };
  });
}

let genFiltro = 'todos';  // todos | mios | novis | vis
let genQuery = '';
function renderGenerales(keep) {
  currentView = 'generales';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  if (!keep) { genFiltro = 'todos'; genQuery = ''; }
  const act = activos(ALL);
  const pend = act.filter(r => estadoDe(r).k === 'pend').length;
  const fin = act.filter(r => estadoDe(r).k === 'fin').length;
  const emerg = act.filter(r => esEmergencia(r) && estadoDe(r).k === 'pend').length;
  content.innerHTML = `<div class="screen">
    <div class="mkpis">
      <div class="mkpi o"><div class="bar"></div><div class="n">${pend}</div><div class="l">Pendientes</div></div>
      <div class="mkpi"><div class="bar"></div><div class="n">${emerg}</div><div class="l">Emergencias</div></div>
      <div class="mkpi g"><div class="bar"></div><div class="n">${fin}</div><div class="l">Cerrados</div></div>
    </div>
    <div class="search-wrap" id="gWrap">
      <span class="ic-lead">🔎</span>
      <input type="text" id="gQ" placeholder="Buscar por acción, descripción, establecimiento…" autocomplete="off" value="${esc(genQuery)}">
      <button class="clearbtn ${genQuery ? '' : 'hidden'}" id="gClr">✕</button>
    </div>
    <div class="seg" style="display:flex;gap:6px;background:#EDEDE9;padding:5px;border-radius:14px;margin-bottom:12px;flex:0 0 auto">
      <button data-f="todos" class="segb ${genFiltro==='todos'?'sel':''}">Todos</button>
      <button data-f="mios" class="segb ${genFiltro==='mios'?'sel':''}">Míos</button>
      <button data-f="novis" class="segb ${genFiltro==='novis'?'sel':''}">No visado</button>
      <button data-f="vis" class="segb ${genFiltro==='vis'?'sel':''}">Visado</button>
    </div>
    <div class="caselist" id="genList"></div>
  </div>`;
  // estilos de los segmentos
  $$('.segb').forEach(b => { b.style.cssText = 'flex:1;text-align:center;padding:9px 4px;border-radius:11px;font-size:12.5px;font-weight:800;cursor:pointer;border:none;background:none;color:var(--muted)'; if (b.classList.contains('sel')) { b.style.background='#fff'; b.style.color='var(--carbon)'; b.style.boxShadow='var(--shadow-sm)'; } b.onclick = () => { genFiltro = b.dataset.f; renderGenerales(true); }; });
  const inp = $('#gQ'), clr = $('#gClr');
  inp.addEventListener('input', () => { genQuery = inp.value; clr.classList.toggle('hidden', !genQuery); paintGenList(); });
  clr.onclick = () => { genQuery=''; inp.value=''; clr.classList.add('hidden'); paintGenList(); };
  paintGenList();
  if (genQuery) setTimeout(()=>{ const i=$('#gQ'); if(i){ i.focus(); i.setSelectionRange(genQuery.length,genQuery.length); } }, 30);
}
function paintGenList() {
  const box = $('#genList'); if (!box) return;
  let list = activos(ALL);
  // filtro por estado
  if (genFiltro === 'mios') list = list.filter(r => norm(r.derivadoA) === norm(CFG.tecnico));
  else if (genFiltro === 'novis') list = list.filter(r => estadoDe(r).k === 'pend' && !r.visado);
  else if (genFiltro === 'vis') list = list.filter(r => (r.visado||'').toString().toLowerCase().includes('visado') && estadoDe(r).k !== 'fin');
  // cotejo de texto sobre TODA la info del caso
  const q = norm(genQuery.trim());
  if (q) {
    list = list.filter(r => {
      const est = r.establecimiento || (estByRbd(r.rbd)||{}).nom || '';
      const blob = norm([r.id, r.descripcion, est, r.rbd, r.categoria, r.fecha, r.fechaSolucionado, estadoDe(r).t, r.derivadoA, r.encargado].join(' '));
      return blob.includes(q);
    });
  }
  list = list.slice().sort((a, b) => tsOf(b) - tsOf(a));
  box.innerHTML = list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">🔎</div><p>${genQuery ? 'Sin resultados para “' + esc(genQuery) + '”.' : 'Sin casos en este filtro.'}</p></div>`;
  bindCaseCards(box, list);
}
function renderHistorico(keep) {
  currentView = 'historico';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  const list = activos(ALL).filter(r => estadoDe(r).k === 'fin').sort((a, b) => tsOf(b) - tsOf(a));
  content.innerHTML = `<div class="screen">
    <div class="mkpis">
      <div class="mkpi g"><div class="bar"></div><div class="n">${list.length}</div><div class="l">Cerrados</div></div>
      <div class="mkpi"><div class="bar"></div><div class="n">${list.filter(esEmergencia).length}</div><div class="l">Emergencias</div></div>
      <div class="mkpi"><div class="bar"></div><div class="n">${new Set(list.map(r => r.rbd)).size}</div><div class="l">Establec.</div></div>
    </div>
    <div class="verif-lbl">Trabajos que has cerrado</div>
    <div class="caselist" id="histList">${list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">🗂️</div><p>Aún no cierras casos.</p></div>`}</div>
  </div>`;
  bindCaseCards($('#histList'), list);
}
function renderBuscar() {
  currentView = 'buscar';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  const byRbd = {};
  for (const r of activos(ALL)) { const k = String(r.rbd); (byRbd[k] = byRbd[k] || []).push(r); }
  content.innerHTML = `<div class="screen">
    <div class="search-wrap" id="bWrap">
      <span class="ic-lead">🔎</span>
      <input type="text" id="bQ" placeholder="Buscar establecimiento o RBD…" autocomplete="off">
      <button class="clearbtn hidden" id="bClr">✕</button>
      <div class="suggest hidden" id="bSug"></div>
    </div>
    <div class="verif-lbl">Establecimientos con casos tuyos</div>
    <div class="caselist" id="bList"></div>
  </div>`;
  const paintList = () => {
    const rbds = Object.keys(byRbd);
    const box = $('#bList');
    box.innerHTML = rbds.length ? rbds.map(rbd => {
      const est = estByRbd(rbd) || { nom: (byRbd[rbd][0].establecimiento || 'Establecimiento'), com: '' };
      const cs = byRbd[rbd]; const pend = cs.filter(r => estadoDe(r).k === 'pend').length;
      return `<div class="case" data-rbd="${esc(rbd)}"><div class="cid">${esc(rbd)}</div><div class="cbody"><div class="ctitle">${esc(est.nom)}</div><div class="cmeta"><span>${cs.length} caso(s)</span><span class="cstate ${pend ? 'pend' : 'fin'}">${pend ? pend + ' pendiente(s)' : 'Todos cerrados'}</span></div></div></div>`;
    }).join('') : `<div class="empty"><div class="ic">🔎</div><p>Sin casos asignados aún.</p></div>`;
    $$('#bList .case[data-rbd]').forEach(c => c.onclick = () => openEstablecimiento(c.dataset.rbd, byRbd));
  };
  paintList();
  const inp = $('#bQ'), sug = $('#bSug'), clr = $('#bClr');
  const paint = () => {
    const v = norm(inp.value.trim()); clr.classList.toggle('hidden', !inp.value);
    if (!v) { sug.classList.add('hidden'); return; }
    const cur = ESTS.filter(e => norm(e.nom).includes(v) || e.rbd.includes(v)).slice(0, 20);
    sug.innerHTML = cur.length ? cur.map(e => `<div class="sopt" data-rbd="${esc(e.rbd)}"><div class="stxt">${esc(e.nom)}<small>RBD ${esc(e.rbd)} · ${esc(e.com)}</small></div></div>`).join('') : `<div class="sopt"><div class="stxt">Sin coincidencias</div></div>`;
    sug.classList.remove('hidden');
    $$('#bSug .sopt[data-rbd]').forEach(d => d.onclick = () => openEstablecimiento(d.dataset.rbd, byRbd));
  };
  inp.addEventListener('input', paint);
  clr.onclick = () => { inp.value = ''; sug.classList.add('hidden'); clr.classList.add('hidden'); inp.focus(); };
}
function openEstablecimiento(rbd, byRbd) {
  currentView = 'establecimiento';
  const est = estByRbd(rbd) || { nom: 'Establecimiento', rbd, dir: '', com: '' };
  const cases = (byRbd[rbd] || activos(ALL).filter(r => String(r.rbd) === String(rbd))).slice().sort((a, b) => tsOf(b) - tsOf(a));
  $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; showNav(false);
  content.innerHTML = `<div class="screen">
    <div class="bubble-head">
      <div class="bh-top"><div class="bh-id">🏫 RBD ${esc(est.rbd)}</div><div class="bh-state">${cases.length} caso(s)</div></div>
      <h3>${esc(est.nom)}</h3><div class="bh-meta"><span>${esc(est.dir || '')}</span><span>${esc(est.com || '')}</span></div>
    </div>
    <div class="verif-lbl">Casos en este establecimiento</div>
    <div class="caselist" id="estList">${cases.length ? cases.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">📭</div><p>Sin casos.</p></div>`}</div>
  </div>`;
  bindCaseCards($('#estList'), cases);
}

/* ===================== DETALLE DE CASO ===================== */
let curCase = null, caseReturn = null;
function openCase(r, from) {
  curCase = r; caseReturn = from || currentView; currentView = 'caso';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  startGpsWatch();  // pedir GPS desde ya

  const st = estadoDe(r); const em = esEmergencia(r);
  const est = estByRbd(r.rbd) || { nom: r.establecimiento, rbd: r.rbd, dir: r.direccion, com: r.comuna };
  const vEnc = verifList(r.verificadores), vTec = verifList(r.verificadoresTecnico);
  const cerrado = st.k === 'fin';

  content.innerHTML = `<div class="screen"><div style="flex:1;overflow-y:auto;display:flex;flex-direction:column">
    <div class="bubble-head ${em ? 'em' : ''}">
      <div class="bh-top"><div class="bh-id">${esc(r.id)}</div><div class="bh-state" id="bhState">${st.t}</div></div>
      <h3>${em ? '🚨 ' : ''}${esc(est.nom || r.establecimiento)} · RBD ${esc(r.rbd)}</h3>
      <div class="bh-meta"><span>${esc(r.categoria || '')}</span><span>${esc(r.fecha || '')}</span><span>👷 ${esc(r.encargado || '')}</span></div>
      <div class="bh-desc">${esc(r.descripcion || 'Sin descripción')}</div>
    </div>

    ${(vEnc.length || vTec.length) ? `<div class="verif-lbl">Verificadores${vTec.length ? ' (encargado + técnico)' : ' del encargado'}</div>
      <div class="verif-strip" id="vstrip">${[...vEnc, ...vTec].map((m, i) => verifThumbHTML(m, i)).join('')}</div>` : ''}

    <div class="state-box">
      <div class="verif-lbl" style="margin-top:0">Estado del caso</div>
      ${cerrado ? `<div class="state-btn sel-sol" style="cursor:default">✓ Solucionado</div>${r.fechaSolucionado ? `<p class="note">Cerrado el ${esc(r.fechaSolucionado)}${r.tiempoResolucion ? ' · ' + esc(r.tiempoResolucion) : ''}.</p>` : ''}` :
      `<div class="state-toggle">
        <div class="state-btn sel-pend" id="stPend"><span class="big">⏳</span> Pendiente</div>
        <div class="state-btn" id="stSol"><span class="big">✓</span> Solucionado</div>
      </div>
      <div class="gps-pill wait" style="margin-top:12px"><span class="gdot"></span><span class="gtxt">Obteniendo ubicación…</span></div>`}
    </div>
  </div></div>`;

  const strip = $('#vstrip');
  if (strip) $$('.vs', strip).forEach((el, i) => el.onclick = () => openViewer([...vEnc, ...vTec], i));
  if (!cerrado) { $('#stSol').onclick = () => openCierre(r); }
  updateGpsPills();

  showNav(true);
  navwrap.querySelector('.inner').innerHTML = `<button class="btn ghost" id="cBack">‹ Atrás</button>`;
  $('#cBack').onclick = goBackFromCase;
}
function verifThumbHTML(m, i) {
  const thumb = m.driveId ? driveThumb(m.driveId) : m.url;
  return `<div class="vs" data-i="${i}">${m.type === 'video' ? `<video src="${esc(m.url)}" muted></video><div class="vt">▶ video</div>` : `<img src="${esc(thumb)}" alt="" onerror="this.style.opacity=.3"><div class="vt">foto</div>`}</div>`;
}
function goBackFromCase() {
  navwrap.querySelector('.inner').innerHTML = `<button class="btn ghost" id="btnBack">‹</button><button class="btn green" id="btnNext">Continuar</button>`;
  const ret = caseReturn;
  if (ret === 'historico') renderHistorico();
  else if (ret === 'establecimiento' || ret === 'buscar') renderBuscar();
  else renderGenerales();
}

/* ===================== FLUJO DE CIERRE (modal) ===================== */
let cierreState = null;
function openCierre(r) {
  if (!gpsFresh()) {
    if (!confirm('Aún no tengo tu ubicación GPS. Es necesaria para cerrar el caso. ¿Intentar de todas formas? (Actívalo en ajustes si falla)')) { startGpsWatch(); return; }
  }
  cierreState = { usoMateriales: null, materiales: [], verificadores: [], uploading: 0 };
  const ov = document.createElement('div'); ov.className = 'modal-bg'; overlays.appendChild(ov);
  ov.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>Cerrar caso ${esc(r.id)}</h3><button class="mclose">✕</button></div>
    <div class="modal-body" id="cierreBody"></div>
    <div class="modal-foot">
      <button class="btn ghost" id="cierreCancel" style="flex:0 0 auto">Cancelar</button>
      <button class="btn green" id="cierreOk" disabled>Marcar solucionado</button>
    </div>
  </div>`;
  const close = () => ov.remove();
  $('.mclose', ov).onclick = close; $('#cierreCancel', ov).onclick = close;
  $('#cierreOk', ov).onclick = () => confirmarCierre(r, close);
  paintCierre();
}
function paintCierre() {
  const body = $('#cierreBody'); if (!body) return;
  const s = cierreState;
  body.innerHTML = `
    <div class="verif-lbl" style="margin-top:0">¿Usó materiales?</div>
    <div class="yesno">
      <button id="matSi" class="${s.usoMateriales === true ? 'sel' : ''}">Sí</button>
      <button id="matNo" class="${s.usoMateriales === false ? 'sel' : ''}">No</button>
    </div>
    <div id="matZone"></div>
    <div class="verif-lbl">Fotos / videos del trabajo</div>
    <div class="up-zone" id="upZone"><div class="up-ic">📷</div><div class="up-t">Agregar foto o video</div><div class="up-s">Cámara o galería · videos se recortan a 15s</div></div>
    <input type="file" id="upInput" accept="image/*,video/*" capture="environment" multiple style="display:none">
    <div class="up-grid" id="upGrid"></div>
    <div class="progress-bar" id="upBar" style="display:none"><div class="fill" id="upFill"></div></div>
    <div class="gps-pill wait" style="margin-top:14px"><span class="gdot"></span><span class="gtxt">Ubicación…</span></div>
  `;
  $('#matSi').onclick = () => { cierreState.usoMateriales = true; paintCierre(); };
  $('#matNo').onclick = () => { cierreState.usoMateriales = false; cierreState.materiales = []; paintCierre(); };
  if (cierreState.usoMateriales === true) paintMatZone();
  bindUploader();
  updateGpsPills();
  updateCierreOk();
}
function paintMatZone() {
  const z = $('#matZone'); if (!z) return;
  const s = cierreState;
  const total = s.materiales.reduce((a, m) => a + (Number(m.cantidad) || 0) * (Number(m.precio) || 0), 0);
  z.innerHTML = `
    <div class="verif-lbl">Materiales utilizados</div>
    ${s.materiales.map((m, i) => `<div class="mat-item"><div class="mi-main"><div class="mi-name">${esc(m.producto)}</div><div class="mi-sub">$${(m.precio || 0).toLocaleString('es-CL')} c/u${m.extra ? ' · ' + esc(m.extra) : ''}</div></div><div class="mi-qty"><input type="number" min="1" value="${m.cantidad}" data-i="${i}"></div><button class="mi-rm" data-i="${i}">🗑️</button></div>`).join('')}
    <button class="add-mat-btn" id="addMat">+ Agregar material</button>
    ${s.materiales.length ? `<div class="mat-total"><span>Total materiales</span><span class="mt-val">$${total.toLocaleString('es-CL')}</span></div>` : ''}
  `;
  $('#addMat').onclick = openMatPicker;
  $$('.mi-qty input', z).forEach(inp => inp.onchange = () => { cierreState.materiales[+inp.dataset.i].cantidad = Math.max(1, +inp.value || 1); paintMatZone(); updateCierreOk(); });
  $$('.mi-rm', z).forEach(b => b.onclick = () => { cierreState.materiales.splice(+b.dataset.i, 1); paintMatZone(); updateCierreOk(); });
}
function openMatPicker() {
  const ov = document.createElement('div'); ov.className = 'modal-bg'; ov.style.zIndex = 2600; overlays.appendChild(ov);
  ov.innerHTML = `<div class="modal" style="max-height:80dvh">
    <div class="modal-head"><h3>Buscar material</h3><button class="mclose">✕</button></div>
    <div class="modal-body">
      <div class="search-wrap"><span class="ic-lead">🔎</span><input type="text" id="matQ" placeholder="Nombre del producto…" autocomplete="off"><button class="clearbtn hidden" id="matClr">✕</button></div>
      <div id="matResults"></div>
    </div></div>`;
  const close = () => ov.remove();
  $('.mclose', ov).onclick = close;
  const inp = $('#matQ', ov), res = $('#matResults', ov), clr = $('#matClr', ov);
  const paint = () => {
    const v = norm(inp.value.trim()); clr.classList.toggle('hidden', !inp.value);
    const list = (v ? PRODUCTOS.filter(p => norm(p.producto).includes(v)) : PRODUCTOS).slice(0, 40);
    res.innerHTML = list.length ? list.map((p, i) => `<div class="mat-item" data-i="${PRODUCTOS.indexOf(p)}" style="cursor:pointer"><div class="mi-main"><div class="mi-name">${esc(p.producto)}</div><div class="mi-sub">$${(Number(p.precio) || 0).toLocaleString('es-CL')} c/u${p.extra ? ' · ' + esc(p.extra) : ''}</div></div><div style="font-size:20px;color:var(--green-d)">+</div></div>`).join('') : `<div class="empty"><div class="ic">📦</div><p>${PRODUCTOS.length ? 'Sin coincidencias' : 'El admin aún no cargó el catálogo de productos.'}</p></div>`;
    $$('.mat-item[data-i]', res).forEach(el => el.onclick = () => {
      const p = PRODUCTOS[+el.dataset.i];
      const ex = cierreState.materiales.find(m => norm(m.producto) === norm(p.producto));
      if (ex) ex.cantidad = (Number(ex.cantidad) || 1) + 1;
      else cierreState.materiales.push({ producto: p.producto, cantidad: 1, precio: Number(p.precio) || 0, extra: p.extra || '' });
      close(); paintMatZone(); updateCierreOk();
    });
  };
  inp.addEventListener('input', paint); clr.onclick = () => { inp.value = ''; clr.classList.add('hidden'); paint(); };
  if (!PRODUCTOS.length) fetchProductos().then(() => paint());
  paint(); setTimeout(() => inp.focus(), 100);
}

/* uploader de verificadores con recorte de video >15s y barra de progreso */
function bindUploader() {
  const zone = $('#upZone'), input = $('#upInput');
  if (!zone) return;
  zone.onclick = () => input.click();
  input.onchange = async () => {
    const files = [...input.files]; input.value = '';
    for (const f of files) await handleUpload(f);
  };
  paintUpGrid();
}
async function handleUpload(file) {
  const isVideo = file.type.startsWith('video');
  const item = { name: file.name, type: isVideo ? 'video' : 'photo', localUrl: URL.createObjectURL(file), progress: 0, url: '', driveId: '' };
  cierreState.verificadores.push(item); cierreState.uploading++;
  paintUpGrid(); updateCierreOk();
  try {
    let blob = file;
    if (!isVideo) blob = await compressImage(file, 1920);
    else if (await videoDuration(file) > 15) { toast('Video largo: se recorta a 15s', 2500); blob = await trimVideo(file, 15); }
    const b64 = await blobToB64(blob);
    item.progress = 40; paintUpGrid();
    const res = await uploadFile(file.name, blob.type || file.type, b64, CFG.tecnico);
    if (res && res.ok && res.url) { item.url = res.url; item.driveId = driveIdFrom(res.url); item.progress = 100; }
    else { item.error = true; toast('No se pudo subir ' + file.name, 3000); }
  } catch (e) { item.error = true; toast('Error al procesar archivo', 3000); }
  cierreState.uploading--; paintUpGrid(); updateCierreOk();
}
function paintUpGrid() {
  const grid = $('#upGrid'); if (!grid) return;
  grid.innerHTML = cierreState.verificadores.map((m, i) => `<div class="up-thumb">
    ${m.type === 'video' ? `<video src="${m.localUrl}" muted></video>` : `<img src="${m.localUrl}">`}
    ${m.progress < 100 && !m.error ? `<div class="prog">${m.progress > 0 ? m.progress + '%' : '<span class="spinner"></span>'}</div>` : ''}
    ${m.error ? `<div class="prog" style="background:rgba(206,66,87,.8)">✕</div>` : ''}
    ${m.progress === 100 ? `<div class="badge">✓</div>` : ''}
    <button class="rm" data-i="${i}">✕</button>
  </div>`).join('');
  $$('.rm', grid).forEach(b => b.onclick = () => { cierreState.verificadores.splice(+b.dataset.i, 1); paintUpGrid(); updateCierreOk(); });
  const bar = $('#upBar'), fill = $('#upFill');
  if (bar) { if (cierreState.uploading > 0) { bar.style.display = 'block'; fill.style.width = '60%'; } else { fill.style.width = '100%'; setTimeout(() => { if (cierreState.uploading === 0 && bar) bar.style.display = 'none'; }, 400); } }
}
function updateCierreOk() {
  const btn = $('#cierreOk'); if (!btn) return;
  const s = cierreState;
  const ready = s.usoMateriales !== null && s.uploading === 0 && (s.usoMateriales === false || s.materiales.length > 0);
  btn.disabled = !ready;
  btn.textContent = s.uploading > 0 ? 'Subiendo archivos…' : 'Marcar solucionado';
}
async function confirmarCierre(r, close) {
  const s = cierreState;
  if (s.uploading > 0) { toast('Espera a que terminen de subir los archivos'); return; }
  if (!gpsFresh() && !confirm('Sin GPS confirmado. ¿Cerrar igual?')) return;
  const btn = $('#cierreOk'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
  const verifStr = s.verificadores.filter(v => v.url).map(v => `${v.type}: ${v.name} -> ${v.url}`).join('\n');
  const now = new Date();
  const res = await postAction({
    accion: 'solucionarTecnico',
    encargado: r.encargado, reporteId: r.id,
    derivadoA: CFG.tecnico, tecnico: CFG.tecnico,
    fechaSolucion: now.toLocaleString('es-CL'), tsSolucion: now.toISOString(),
    gps: gpsString(),
    verificadoresTecnico: verifStr,
    materiales: s.materiales.map(m => ({ producto: m.producto, cantidad: Number(m.cantidad) || 0, precio: Number(m.precio) || 0, extra: m.extra || '' }))
  });
  if (res && res.ok) {
    r.visado = 'SOLUCIONADO'; r.fechaSolucionado = now.toLocaleString('es-CL'); r.verificadoresTecnico = verifStr;
    const a = ALL.find(x => x.id === r.id && x.encargado === r.encargado); if (a) { a.visado = 'SOLUCIONADO'; a.fechaSolucionado = r.fechaSolucionado; a.verificadoresTecnico = verifStr; }
    toast('Caso solucionado ✓', 2600);
    close(); goBackFromCase();
  } else { toast('No se pudo cerrar: ' + ((res && res.error) || 'error'), 3500); btn.disabled = false; btn.textContent = 'Marcar solucionado'; }
}

/* ===================== helpers de media ===================== */
function blobToB64(blob) { return new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result.split(',')[1]); rd.onerror = rej; rd.readAsDataURL(blob); }); }
function compressImage(file, maxSide) {
  return new Promise(resolve => {
    const img = new Image(); img.onload = () => {
      let { width: w, height: h } = img;
      if (Math.max(w, h) > maxSide) { const s = maxSide / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(b => resolve(b || file), 'image/jpeg', 0.85);
    }; img.onerror = () => resolve(file); img.src = URL.createObjectURL(file);
  });
}
function videoDuration(file) { return new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => res(v.duration || 0); v.onerror = () => res(0); v.src = URL.createObjectURL(file); }); }
async function trimVideo(file, seconds) {
  // recorte simple con MediaRecorder capturando los primeros N segundos
  return new Promise(async (resolve) => {
    try {
      const v = document.createElement('video'); v.src = URL.createObjectURL(file); v.muted = true;
      await new Promise(r => { v.onloadedmetadata = r; });
      const stream = v.captureStream ? v.captureStream() : (v.mozCaptureStream && v.mozCaptureStream());
      if (!stream || typeof MediaRecorder === 'undefined') return resolve(file);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = [];
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      v.play(); rec.start();
      setTimeout(() => { rec.stop(); v.pause(); }, seconds * 1000);
    } catch (e) { resolve(file); }
  });
}

/* ===================== VISOR ===================== */
function openViewer(items, start) {
  if (!items || !items.length) { toast('Sin verificadores'); return; }
  let idx = start || 0;
  const ov = document.createElement('div'); ov.className = 'viewer-bg'; overlays.appendChild(ov);
  const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
  const onKey = e => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
  document.addEventListener('keydown', onKey);
  const go = d => { const n = idx + d; if (n < 0 || n >= items.length) return; idx = n; render(); };
  function mediaHTML(it) {
    if (it.type === 'video') { if (it.driveId) return `<iframe src="${driveVideoPreview(it.driveId)}" allow="autoplay; fullscreen" allowfullscreen></iframe>`; return `<video src="${esc(it.url)}" controls autoplay playsinline></video>`; }
    if (it.driveId) { const [src, fb] = driveImgSources(it.driveId); return `<img src="${src}" data-fb="${fb}" data-tries="0" alt="" onerror="if(this.dataset.tries==='0'){this.dataset.tries='1';this.src=this.dataset.fb;}">`; }
    return `<div style="color:#ddd;text-align:center;padding:24px">No se pudo mostrar. ${it.url ? `<a href="${esc(it.url)}" target="_blank" style="color:var(--orange)">Abrir ↗</a>` : ''}</div>`;
  }
  function render() {
    const it = items[idx]; const openUrl = it.driveId ? driveOpenUrl(it.driveId) : it.url;
    ov.innerHTML = `<div class="viewer-top"><span class="vcount">${idx + 1} / ${items.length}</span>${openUrl ? `<a class="vopen" href="${esc(openUrl)}" target="_blank" rel="noopener">Abrir ↗</a>` : '<span style="margin-left:auto"></span>'}<button class="vclose">✕</button></div>
      <div class="viewer-stage">${items.length > 1 ? `<button class="viewer-nav prev" ${idx === 0 ? 'disabled' : ''}>‹</button>` : ''}${mediaHTML(it)}${items.length > 1 ? `<button class="viewer-nav next" ${idx === items.length - 1 ? 'disabled' : ''}>›</button>` : ''}</div>
      <div class="viewer-cap">${esc(it.name || '')}</div>`;
    $('.vclose', ov).onclick = close;
    const pv = $('.viewer-nav.prev', ov), nx = $('.viewer-nav.next', ov);
    if (pv) pv.onclick = () => go(-1); if (nx) nx.onclick = () => go(1);
  }
  let sx = null; ov.addEventListener('touchstart', e => sx = e.touches[0].clientX, { passive: true });
  ov.addEventListener('touchend', e => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1); }, { passive: true });
  ov.addEventListener('click', e => { if (e.target === ov || e.target.classList.contains('viewer-stage')) close(); });
  render();
}

/* ===================== ARRANQUE ===================== */
(async function init() {
  if (CFG.sheetUrl) { const t = await fetchTecnicos(); if (t) TECNICOS = t; }
  if (CFG.sheetUrl && CFG.tecnico) {
    renderHome();
    await refreshData(false);
    fetchProductos();
    renderHome();
    startPolling();
    startGpsWatch();
  } else {
    renderHome();
  }
})();
