// MusiMix — export PDF : une partition propre (paroles, accords, diagrammes),
// imprimée par le navigateur (« Enregistrer au format PDF »).

import { esc, dialog, toast } from './ui.js';
import { renderSheet, chordDisplay, uniqueChords } from './render.js';
import { diagramSVG, loadChordDb, setSongShapes } from './diagrams.js';
import { keyName } from './theory.js';
import { db } from './db.js';
import { loadAlphaTab, AT_BASE } from './score.js';

export async function printDialog(app, songs, opts = {}) {
  await loadChordDb();
  const prefs = await app.prefs();
  const st = {
    instrument: opts.instrument || prefs.pdfInstrument || prefs.instrument || 'guitar',
    transpose: opts.transpose ?? (songs.length === 1 ? (songs[0].prefs?.transpose || 0) - (songs[0].prefs?.capo || 0) : 0),
    cols: prefs.pdfCols || 1,
    size: prefs.pdfSize || 13.5,
    diagrams: prefs.pdfDiagrams !== false,
    chords: true,
    mode: 'lyrics', // lyrics | grid | score
    gLyrics: prefs.pdfGridLyrics !== false,
    gChords: true,
  };
  const one = songs.length === 1 ? songs[0] : null;
  // grille par mesure : fournie par le lecteur quand le tempo est connu ; sinon grille simple (suite d'accords par partie)
  const gridMeasured = one && opts.gridHtml ? opts.gridHtml() : null;
  const hasScore = !!(one?.score?.blobId);
  st.mode = ['lyrics', 'grid', 'score'].includes(opts.mode) ? opts.mode : (prefs.pdfMode || 'lyrics');
  if (st.mode === 'score' && !hasScore) st.mode = 'lyrics';
  st.gridMeasured = gridMeasured;
  const d = dialog(`<div class="dlg">
    <h2>PDF et impression</h2>
    <div style="display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:20px" class="pdf-grid">
      <div style="display:grid;gap:12px;align-content:start">
        <div class="opt-row pdf-mode"><span>Contenu</span><span class="seg"><button data-mode="lyrics">Paroles</button><button data-mode="grid">Grille</button>${hasScore ? '<button data-mode="score">Partition</button>' : ''}</span></div>
        <label class="field pdf-nsc">Instrument des diagrammes
          <select data-o="instrument"><option value="guitar">Guitare</option><option value="ukulele">Ukulélé</option><option value="piano">Piano</option><option value="none">Aucun</option></select></label>
        <div class="opt-row pdf-nsc"><span>Transposer</span><span class="stepper"><button data-o="tr-">−</button><output data-r="tr"></output><button data-o="tr+">+</button></span></div>
        <div class="opt-row pdf-lyr"><span>Colonnes</span><span class="seg"><button data-cols="1">1</button><button data-cols="2">2</button></span></div>
        <div class="opt-row pdf-nsc"><span>Taille du texte</span><span class="stepper"><button data-o="fs-">−</button><output data-r="fs"></output><button data-o="fs+">+</button></span></div>
        <div class="opt-row pdf-lyr"><span>Afficher les accords</span><label class="switch"><input type="checkbox" data-o="chords" checked><i></i></label></div>
        <div class="opt-row pdf-grd"><span>Paroles dans la grille</span><label class="switch"><input type="checkbox" data-o="gly" ${st.gLyrics ? 'checked' : ''}><i></i></label></div>
        <div class="opt-row pdf-nsc"><span>Diagrammes des accords</span><label class="switch"><input type="checkbox" data-o="diag" ${st.diagrams ? 'checked' : ''}><i></i></label></div>
        <p class="note pdf-gnote" hidden>Grille sans mesures : le tempo du morceau est inconnu (« Tout préparer » le trouve). Les accords sont listés dans l’ordre, par partie.</p>
        <p class="note">Une imprimante branchée ou en Wi-Fi apparaît dans la fenêtre d’impression. Pour un fichier, choisis <b>Enregistrer au format PDF</b>. Sur iPhone : <b>Partager → Imprimer</b>, puis écarte l’aperçu avec deux doigts.</p>
      </div>
      <div class="pdf-prev" style="max-height:64vh;overflow:auto;background:var(--surface-3);border-radius:12px;padding:14px"><div data-r="prev"></div></div>
    </div>
    <div class="actions"><button class="btn ghost" data-close="">Annuler</button><button class="btn primary" data-o="print">Imprimer / PDF</button></div>
  </div>`, { cls: 'wide' });
  const el = d.el;
  if (window.innerWidth < 760) el.querySelector('.pdf-grid').style.gridTemplateColumns = '1fr';
  const sel = el.querySelector('[data-o="instrument"]');
  sel.value = st.diagrams ? st.instrument : 'none';
  const refresh = () => {
    el.querySelector('[data-r="tr"]').textContent = st.transpose ? (st.transpose > 0 ? '+' : '−') + Math.abs(st.transpose) : '0';
    el.querySelector('[data-r="fs"]').textContent = st.size.toString().replace('.', ',') + ' pt';
    el.querySelectorAll('[data-cols]').forEach((b) => b.classList.toggle('on', +b.dataset.cols === st.cols));
    el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === st.mode));
    el.querySelectorAll('.pdf-lyr').forEach((x) => { x.hidden = st.mode !== 'lyrics'; });
    el.querySelectorAll('.pdf-grd').forEach((x) => { x.hidden = st.mode !== 'grid'; });
    el.querySelectorAll('.pdf-nsc').forEach((x) => { x.hidden = st.mode === 'score'; });
    el.querySelector('.pdf-gnote').hidden = !(st.mode === 'grid' && !st.gridMeasured);
    const prev = el.querySelector('[data-r="prev"]');
    const box = el.querySelector('.pdf-prev');
    prev.style.zoom = Math.min(1, (box.clientWidth - 28) / 794);
    if (st.mode === 'score') {
      if (!st.scoreHtml) {
        prev.innerHTML = songPage(one, { ...st, scoreHtml: '<p class="note">Mise en page de la partition…</p>' }, true);
        scoreHtml(one).catch((e) => `<p>Partition indisponible : ${esc(e?.message || e)}</p>`).then((h) => { st.scoreHtml = h; if (st.mode === 'score') refresh(); });
        return;
      }
    }
    prev.innerHTML = songs.slice(0, 1).map((s) => songPage(s, st, true)).join('');
  };
  el.querySelector('.pdf-mode').addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]'); if (!m) return;
    st.mode = m.dataset.mode; refresh();
  });
  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cols]');
    if (c) { st.cols = +c.dataset.cols; refresh(); return; }
    const b = e.target.closest('[data-o]');
    if (!b) return;
    const o = b.dataset.o;
    if (o === 'tr-') st.transpose--;
    if (o === 'tr+') st.transpose++;
    if (o === 'fs-') st.size = Math.max(9, st.size - 0.5);
    if (o === 'fs+') st.size = Math.min(22, st.size + 0.5);
    if (o === 'print') {
      app.setPref('pdfInstrument', st.instrument);
      app.setPref('pdfCols', st.cols);
      app.setPref('pdfSize', st.size);
      app.setPref('pdfDiagrams', st.diagrams);
      app.setPref('pdfMode', st.mode);
      app.setPref('pdfGridLyrics', st.gLyrics);
      if (st.mode === 'score' && !st.scoreHtml) { toast('La partition se met en page, réessaie dans un instant'); return; }
      d.close();
      doPrint(songs, st);
      return;
    }
    refresh();
  });
  el.addEventListener('change', (e) => {
    if (e.target === sel) { st.diagrams = sel.value !== 'none'; if (st.diagrams) st.instrument = sel.value; el.querySelector('[data-o="diag"]').checked = st.diagrams; refresh(); }
    if (e.target.dataset.o === 'chords') { st.chords = e.target.checked; refresh(); }
    if (e.target.dataset.o === 'gly') { st.gLyrics = e.target.checked; refresh(); }
    if (e.target.dataset.o === 'diag') { st.diagrams = e.target.checked; if (st.diagrams && sel.value === 'none') sel.value = st.instrument === 'none' ? 'guitar' : st.instrument; refresh(); }
  });
  refresh();
}

function songPage(song, st, preview = false) {
  const display = chordDisplay(song, st.transpose, 0);
  const doc = st.chords ? song.doc : { ...song.doc, lines: song.doc.lines.filter((l) => l.type !== 'chords').map((l) => ({ ...l, chords: [] })) };
  setSongShapes(song.doc?.meta?.shapes, song.doc?.meta?.piano);
  const chords = (st.mode === 'grid' ? st.gChords : st.chords) && st.diagrams && st.mode !== 'score' ? uniqueChords(song.doc, display, song.detectedChords) : [];
  const facts = [];
  const k = display.keyLabel;
  if (k) facts.push(['Tonalité', k]);
  if (song.capo && !st.transpose) facts.push(['Capo', song.capo]);
  if (song.bpm) facts.push(['Tempo', Math.round(song.bpm)]);
  let body = doc.lines.length ? renderSheet(doc, { display }) : '<p>Pas de paroles.</p>';
  let bodyCls = 'body';
  if (st.mode === 'grid') { body = st.gridMeasured || simpleGrid(song.doc, display); bodyCls = `body grid-body${st.gLyrics ? '' : ' no-ly'}${st.gChords ? '' : ' no-ch'}`; }
  if (st.mode === 'score') { body = st.scoreHtml || ''; bodyCls = 'body score-body'; }
  const showDiag = st.mode !== 'score';
  return `<article class="pr${preview ? ' preview' : ''}" style="--cols:${st.cols};--pfs:${st.size}pt">
    <header><div><h1>${esc(song.title || 'Sans titre')}</h1>${song.artist ? `<div class="by">${esc(song.artist)}</div>` : ''}</div>
      <div class="facts">${facts.map(([a, b]) => `<div>${esc(a)}<b>${esc(b)}</b></div>`).join('')}</div></header>
    ${chords.length && showDiag ? `<div class="chords-row">${chords.map((c) => `<figure><figcaption>${esc(c)}</figcaption>${diagramSVG(c, st.instrument)}</figure>`).join('')}</div>` : ''}
    <div class="${bodyCls}">${body}</div>
    <footer><span>${esc(song.title || '')}${song.artist ? ' — ' + esc(song.artist) : ''}</span><span>MusiMix</span></footer>
  </article>`;
}

function doPrint(songs, st) {
  let root = document.getElementById('print-root');
  if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  root.innerHTML = songs.map((s, i) => `<div style="${i ? 'break-before:page' : ''}">${songPage(s, st)}</div>`).join('');
  const title = document.title;
  document.title = songs.length === 1 ? `${songs[0].title || 'Partition'}${songs[0].artist ? ' - ' + songs[0].artist : ''}` : 'Setlist MusiMix';
  const done = () => { document.title = title; root.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  // laisse le temps aux polices et SVG de se poser
  setTimeout(() => window.print(), 250);
}

/** Grille simple sans tempo : par partie, les accords dans l'ordre (une case par accord). */
function simpleGrid(doc, display) {
  const name = (n) => esc(typeof display === 'function' ? display(n) : n);
  let html = '', cur = null, cells = [];
  const flush = () => { if (cells.length || cur) html += `<section class="sg"><h3>${esc(cur || '')}</h3><div class="sg-row">${cells.map((c) => `<div class="sg-c"><b>${c.n}</b>${c.w ? `<small>${esc(c.w)}</small>` : ''}</div>`).join('')}</div></section>`; cells = []; };
  for (const l of doc?.lines || []) {
    if (l.type === 'section') { flush(); cur = l.label || l.text || ''; continue; }
    if (!l.chords?.length) continue;
    const cs = [...l.chords].sort((a, b) => a.pos - b.pos);
    cs.forEach((c, i) => {
      const w = l.type === 'lyric' ? (l.text || '').slice(c.pos, cs[i + 1]?.pos ?? undefined).trim().split(/\s+/).slice(0, 3).join(' ') : '';
      cells.push({ n: name(c.name), w });
    });
  }
  flush();
  return html || '<p>Aucun accord.</p>';
}

/** Partition mise en page pour l'impression : rendu alphaTab hors écran, découpé ligne par ligne (pas de portée coupée). */
const scoreCache = new Map();
async function scoreHtml(song) {
  const sc = song.score, key = `${song.id}:${sc.blobId}:${sc.track || 0}:${sc.layout || ''}`;
  if (scoreCache.has(key)) return scoreCache.get(key);
  const blob = await db.getBlob(sc.blobId);
  if (!blob) return '<p>Partition absente sur cet appareil.</p>';
  const AT = await loadAlphaTab();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:718px;background:#fff';
  document.body.appendChild(host);
  const PROF = { both: 'Default', tab: 'Tab', score: 'Score' };
  const html = await new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      const surf = host.querySelector('.at-surface') || host;
      const parts = [...surf.children].filter((c) => c.querySelector('svg'))
        .map((c) => ({ top: parseFloat(c.style.top) || 0, left: parseFloat(c.style.left) || 0, h: parseFloat(c.style.height) || c.offsetHeight, w: parseFloat(c.style.width) || c.offsetWidth, html: c.innerHTML }))
        .sort((a, b) => a.top - b.top || a.left - b.left);
      // regroupe les morceaux d'une même rangée
      const rows = [];
      for (const p of parts) { const r = rows[rows.length - 1]; if (r && Math.abs(r.top - p.top) < 2) r.items.push(p); else rows.push({ top: p.top, items: [p] }); }
      res(rows.map((r) => `<div class="sc-row" style="height:${Math.max(...r.items.map((p) => p.h))}px">${r.items.map((p) => `<div style="position:absolute;left:${p.left}px;top:0;width:${p.w}px;height:${p.h}px">${p.html}</div>`).join('')}</div>`).join(''));
    };
    try {
      const api = new AT.AlphaTabApi(host, {
        core: { fontDirectory: AT_BASE + 'font/', useWorkers: false, enableLazyLoading: false, engine: 'svg' },
        display: { staveProfile: AT.StaveProfile[PROF[sc.layout] || 'Default'], scale: 0.85, layoutMode: AT.LayoutMode.Page },
        player: { playerMode: AT.PlayerMode?.Disabled ?? 0, enablePlayer: false },
      });
      (api.postRenderFinished || api.renderFinished).on(() => setTimeout(() => { finish(); try { api.destroy(); } catch { /* */ } host.remove(); }, 400));
      api.error.on(() => { res('<p>Partition illisible.</p>'); host.remove(); });
      blob.arrayBuffer().then((b) => api.load(new Uint8Array(b), [sc.track || 0]));
      setTimeout(() => { if (!done) { finish(); host.remove(); } }, 30000);
    } catch (e) { res(`<p>Partition illisible : ${esc(e.message || e)}</p>`); host.remove(); }
  });
  scoreCache.set(key, html);
  return html;
}

export { keyName };
